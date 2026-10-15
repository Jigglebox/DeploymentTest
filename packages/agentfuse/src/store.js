// Persistence for AgentFuse: virtual keys with policies, a per-request cost ledger, and events.
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, nowIso } from '@jigglebox/shared/db';
import { DEFAULT_POLICY } from './config.js';

const MIGRATIONS = [
  `CREATE TABLE keys (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     key_hash TEXT NOT NULL UNIQUE,
     key_prefix TEXT NOT NULL,
     policy TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     tripped_reason TEXT,
     tripped_at TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE ledger (
     id INTEGER PRIMARY KEY,
     key_id TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
     run_id TEXT,
     provider TEXT NOT NULL,
     model TEXT,
     fingerprint TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     estimated INTEGER NOT NULL DEFAULT 0,
     status INTEGER,
     latency_ms INTEGER,
     created_at TEXT NOT NULL
   );
   CREATE INDEX ledger_key_time ON ledger(key_id, created_at);
   CREATE INDEX ledger_key_fp ON ledger(key_id, fingerprint, created_at);
   CREATE INDEX ledger_run ON ledger(run_id);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     key_id TEXT,
     type TEXT NOT NULL,
     detail TEXT,
     created_at TEXT NOT NULL
   );`,
];

export const hashKey = (raw) => createHash('sha256').update(raw).digest('hex');
export const fingerprintBody = (body) => {
  const { stream, stream_options, ...rest } = body ?? {};
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 32);
};

const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
const dayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
const secondsAgo = (s, d = new Date()) => new Date(d.getTime() - s * 1000).toISOString();

export class Store {
  constructor(dbPath = ':memory:') {
    this.db = openDatabase(dbPath, MIGRATIONS);
    this.q = {
      insertKey: this.db.prepare('INSERT INTO keys (id,name,key_hash,key_prefix,policy,status,created_at) VALUES (?,?,?,?,?,?,?)'),
      keyByHash: this.db.prepare('SELECT * FROM keys WHERE key_hash = ?'),
      keyById: this.db.prepare('SELECT * FROM keys WHERE id = ?'),
      listKeys: this.db.prepare('SELECT * FROM keys ORDER BY created_at DESC'),
      countKeys: this.db.prepare('SELECT COUNT(*) AS n FROM keys'),
      setStatus: this.db.prepare('UPDATE keys SET status=?, tripped_reason=?, tripped_at=? WHERE id=?'),
      setPolicy: this.db.prepare('UPDATE keys SET policy=? WHERE id=?'),
      deleteKey: this.db.prepare('DELETE FROM keys WHERE id=?'),
      insertLedger: this.db.prepare(`INSERT INTO ledger (key_id,run_id,provider,model,fingerprint,input_tokens,output_tokens,cost_usd,estimated,status,latency_ms,created_at)
                                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      spendSince: this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS usd, COUNT(*) AS n FROM ledger WHERE key_id=? AND created_at>=?'),
      spendRun: this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS usd FROM ledger WHERE key_id=? AND run_id=?'),
      repeats: this.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE key_id=? AND fingerprint=? AND created_at>=?'),
      recentLedger: this.db.prepare('SELECT * FROM ledger WHERE key_id=? ORDER BY id DESC LIMIT ?'),
      insertEvent: this.db.prepare('INSERT INTO events (key_id,type,detail,created_at) VALUES (?,?,?,?)'),
      recentEvents: this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
      totals: this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS usd, COUNT(*) AS n FROM ledger WHERE created_at>=?'),
      byModel: this.db.prepare('SELECT model, COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS usd FROM ledger WHERE created_at>=? GROUP BY model ORDER BY usd DESC LIMIT 20'),
    };
  }

  createKey({ name, policy = {} }) {
    const raw = 'af_live_' + randomBytes(24).toString('base64url');
    const id = 'key_' + randomBytes(8).toString('hex');
    const merged = { ...DEFAULT_POLICY, ...policy };
    this.q.insertKey.run(id, name, hashKey(raw), raw.slice(0, 12) + '…', JSON.stringify(merged), 'active', nowIso());
    return { ...this.getKey(id), raw_key: raw };
  }

  _hydrate(row) { return row ? { ...row, policy: JSON.parse(row.policy) } : null; }
  getKey(id) { return this._hydrate(this.q.keyById.get(id)); }
  findKeyByRaw(raw) { return this._hydrate(this.q.keyByHash.get(hashKey(raw))); }
  listKeys() { return this.q.listKeys.all().map((r) => this._hydrate(r)); }
  countKeys() { return this.q.countKeys.get().n; }
  deleteKey(id) { this.q.deleteKey.run(id); }
  updatePolicy(id, patch) {
    const key = this.getKey(id);
    if (!key) return null;
    this.q.setPolicy.run(JSON.stringify({ ...key.policy, ...patch }), id);
    return this.getKey(id);
  }

  trip(id, reason, detail = {}) {
    this.q.setStatus.run('tripped', reason, nowIso(), id);
    this.event(id, 'tripped', { reason, ...detail });
  }
  resume(id) { this.q.setStatus.run('active', null, null, id); this.event(id, 'resumed', {}); }
  disable(id) { this.q.setStatus.run('disabled', 'disabled by admin', nowIso(), id); this.event(id, 'disabled', {}); }

  setting(key) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), nowIso()); }
  /** Effective plan: a paid subscription recorded via billing beats the env default. */
  plan(fallback = 'free') { return this.setting('plan') ?? fallback; }

  event(keyId, type, detail) { this.q.insertEvent.run(keyId, type, JSON.stringify(detail), nowIso()); }
  recentEvents(limit = 50) { return this.q.recentEvents.all(limit).map((e) => ({ ...e, detail: JSON.parse(e.detail ?? '{}') })); }

  record(entry) {
    this.q.insertLedger.run(entry.keyId, entry.runId ?? null, entry.provider, entry.model ?? null, entry.fingerprint ?? null,
      entry.inputTokens ?? 0, entry.outputTokens ?? 0, entry.costUsd ?? 0, entry.estimated ? 1 : 0, entry.status ?? null,
      entry.latencyMs ?? null, entry.at ?? nowIso());
  }

  /** Everything the policy engine needs to decide, in one read. */
  snapshot(keyId, { runId = null, loopWindowSec = 120, fingerprint = null, now = new Date() } = {}) {
    const month = this.q.spendSince.get(keyId, monthStart(now));
    const day = this.q.spendSince.get(keyId, dayStart(now));
    const lastMinute = this.q.spendSince.get(keyId, secondsAgo(60, now));
    const lastHour = this.q.spendSince.get(keyId, secondsAgo(3600, now));
    return {
      monthUsd: month.usd, dayUsd: day.usd, hourUsd: lastHour.usd, requestsLastMinute: lastMinute.n,
      runUsd: runId ? this.q.spendRun.get(keyId, runId).usd : 0,
      repeats: fingerprint ? this.q.repeats.get(keyId, fingerprint, secondsAgo(loopWindowSec, now)).n : 0,
    };
  }

  recentLedger(keyId, limit = 50) { return this.q.recentLedger.all(keyId, limit); }
  totals(now = new Date()) { return { month: this.q.totals.get(monthStart(now)), day: this.q.totals.get(dayStart(now)), byModel: this.q.byModel.all(monthStart(now)) }; }
  close() { this.db.close(); }
}

// --- alert de-duplication -------------------------------------------------
Store.prototype.lastEventAt = function (keyId, type) {
  const row = this.db.prepare('SELECT created_at FROM events WHERE key_id=? AND type=? ORDER BY id DESC LIMIT 1').get(keyId, type);
  return row?.created_at ?? null;
};
