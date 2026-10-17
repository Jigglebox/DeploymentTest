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
  // v2: organisations (tenants). Every key belongs to an org; 'org_default' is the single-tenant org.
  `CREATE TABLE orgs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT UNIQUE,
     password_hash TEXT,
     token_hash TEXT UNIQUE,
     token_prefix TEXT,
     plan TEXT,
     billing TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE org_providers (
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     provider TEXT NOT NULL,
     api_key_sealed TEXT NOT NULL,
     base_url TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (org_id, provider)
   );
   ALTER TABLE keys ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
   CREATE INDEX keys_org ON keys(org_id);`,
];
export const DEFAULT_ORG = 'org_default';

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
      insertKey: this.db.prepare('INSERT INTO keys (id,name,key_hash,key_prefix,policy,status,created_at,org_id) VALUES (?,?,?,?,?,?,?,?)'),
      keyByHash: this.db.prepare('SELECT * FROM keys WHERE key_hash = ?'),
      keyById: this.db.prepare('SELECT * FROM keys WHERE id = ?'),
      listKeys: this.db.prepare('SELECT * FROM keys WHERE org_id=? ORDER BY created_at DESC'),
      countKeys: this.db.prepare('SELECT COUNT(*) AS n FROM keys WHERE org_id=?'),
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
      recentEvents: this.db.prepare('SELECT e.* FROM events e JOIN keys k ON k.id=e.key_id WHERE k.org_id=? ORDER BY e.id DESC LIMIT ?'),
      totals: this.db.prepare('SELECT COALESCE(SUM(l.cost_usd),0) AS usd, COUNT(*) AS n FROM ledger l JOIN keys k ON k.id=l.key_id WHERE k.org_id=? AND l.created_at>=?'),
      byModel: this.db.prepare('SELECT l.model, COUNT(*) AS n, COALESCE(SUM(l.cost_usd),0) AS usd FROM ledger l JOIN keys k ON k.id=l.key_id WHERE k.org_id=? AND l.created_at>=? GROUP BY l.model ORDER BY usd DESC LIMIT 20'),
      insertOrg: this.db.prepare('INSERT INTO orgs (id,name,email,password_hash,token_hash,token_prefix,plan,billing,created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
      orgById: this.db.prepare('SELECT * FROM orgs WHERE id=?'),
      orgByEmail: this.db.prepare('SELECT * FROM orgs WHERE email=?'),
      orgByToken: this.db.prepare('SELECT * FROM orgs WHERE token_hash=?'),
      orgBySub: this.db.prepare("SELECT * FROM orgs WHERE json_extract(billing,'$.subscriptionId')=?"),
      setOrgPlan: this.db.prepare('UPDATE orgs SET plan=? WHERE id=?'),
      setOrgBilling: this.db.prepare('UPDATE orgs SET billing=? WHERE id=?'),
      upsertProvider: this.db.prepare('INSERT INTO org_providers (org_id,provider,api_key_sealed,base_url,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(org_id,provider) DO UPDATE SET api_key_sealed=excluded.api_key_sealed, base_url=excluded.base_url, updated_at=excluded.updated_at'),
      providersFor: this.db.prepare('SELECT * FROM org_providers WHERE org_id=?'),
      deleteProvider: this.db.prepare('DELETE FROM org_providers WHERE org_id=? AND provider=?'),
    };
  }

  createKey({ name, policy = {}, orgId = DEFAULT_ORG }) {
    const raw = 'af_live_' + randomBytes(24).toString('base64url');
    const id = 'key_' + randomBytes(8).toString('hex');
    const merged = { ...DEFAULT_POLICY, ...policy };
    this.q.insertKey.run(id, name, hashKey(raw), raw.slice(0, 12) + '…', JSON.stringify(merged), 'active', nowIso(), orgId);
    return { ...this.getKey(id), raw_key: raw };
  }

  // ---- organisations ----
  _org(row) { return row ? { ...row, billing: row.billing ? JSON.parse(row.billing) : null, password_hash: undefined, token_hash: undefined } : null; }
  ensureDefaultOrg() {
    if (!this.q.orgById.get(DEFAULT_ORG)) this.q.insertOrg.run(DEFAULT_ORG, 'default', null, null, null, null, null, null, nowIso());
    return this.getOrg(DEFAULT_ORG);
  }
  createOrg({ name, email, passwordHash }) {
    if (this.q.orgByEmail.get(email)) throw Object.assign(new Error('an account with that email already exists'), { status: 409 });
    const id = 'org_' + randomBytes(8).toString('hex');
    const raw = 'af_org_' + randomBytes(24).toString('base64url');
    this.q.insertOrg.run(id, name, email, passwordHash, hashKey(raw), raw.slice(0, 11) + '…', null, null, nowIso());
    return { ...this.getOrg(id), raw_token: raw };
  }
  getOrg(id) { return this._org(this.q.orgById.get(id)); }
  orgByEmail(email) { return this.q.orgByEmail.get(email) ?? null; } // includes password_hash, for login only
  orgByToken(raw) { return this._org(this.q.orgByToken.get(hashKey(raw))); }
  orgBySubscription(subId) { return this._org(this.q.orgBySub.get(subId)); }
  setOrgPlan(orgId, plan) { this.q.setOrgPlan.run(plan, orgId); }
  setOrgBilling(orgId, billing) { this.q.setOrgBilling.run(JSON.stringify(billing), orgId); }
  /** Effective plan for an org: a paid subscription recorded via billing beats the env default. */
  plan(orgId, fallback = 'free') { return this.getOrg(orgId)?.plan ?? fallback; }
  /** Recurring revenue from plans on record (hosted mode); prices in cents. */
  mrr(prices = { pro: 2900, team: 9900 }) {
    const rows = this.db.prepare("SELECT plan, COUNT(*) AS n FROM orgs WHERE plan IN ('pro','team') GROUP BY plan").all();
    return { label: 'MRR', mrr_cents: rows.reduce((a, r) => a + (prices[r.plan] ?? 0) * r.n, 0), paying: rows.reduce((a, r) => a + r.n, 0) };
  }
  /** Orgs created before `beforeIso` with no keys (or no traffic), for onboarding nudges. */
  orgsWithoutKeys(beforeIso) { return this.db.prepare("SELECT o.* FROM orgs o WHERE o.email IS NOT NULL AND o.created_at<? AND NOT EXISTS (SELECT 1 FROM keys k WHERE k.org_id=o.id)").all(beforeIso).map((r) => this._org(r)); }
  orgsWithoutTraffic(beforeIso) { return this.db.prepare("SELECT o.* FROM orgs o WHERE o.email IS NOT NULL AND o.created_at<? AND EXISTS (SELECT 1 FROM keys k WHERE k.org_id=o.id) AND NOT EXISTS (SELECT 1 FROM ledger l JOIN keys k ON k.id=l.key_id WHERE k.org_id=o.id AND l.status<400)").all(beforeIso).map((r) => this._org(r)); }
  setProvider(orgId, provider, { apiKeySealed, baseUrl = null }) { this.q.upsertProvider.run(orgId, provider, apiKeySealed, baseUrl, nowIso()); }
  providersFor(orgId) { return this.q.providersFor.all(orgId); }
  deleteProvider(orgId, provider) { this.q.deleteProvider.run(orgId, provider); }

  _hydrate(row) { return row ? { ...row, policy: JSON.parse(row.policy) } : null; }
  getKey(id) { return this._hydrate(this.q.keyById.get(id)); }
  findKeyByRaw(raw) { return this._hydrate(this.q.keyByHash.get(hashKey(raw))); }
  listKeys(orgId = DEFAULT_ORG) { return this.q.listKeys.all(orgId).map((r) => this._hydrate(r)); }
  countKeys(orgId = DEFAULT_ORG) { return this.q.countKeys.get(orgId).n; }
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

  event(keyId, type, detail) { this.q.insertEvent.run(keyId, type, JSON.stringify(detail), nowIso()); }
  recentEvents(orgId = DEFAULT_ORG, limit = 50) { return this.q.recentEvents.all(orgId, limit).map((e) => ({ ...e, detail: JSON.parse(e.detail ?? '{}') })); }

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
  /** Full ledger for an org in a window, for CSV export. */
  exportLedger(orgId, fromIso, toIso) {
    return this.db.prepare('SELECT l.created_at, k.name AS key_name, l.key_id, l.run_id, l.provider, l.model, l.input_tokens, l.output_tokens, l.cost_usd, l.estimated, l.status, l.latency_ms FROM ledger l JOIN keys k ON k.id=l.key_id WHERE k.org_id=? AND l.created_at>=? AND l.created_at<? ORDER BY l.id').all(orgId, fromIso, toIso);
  }
  totals(orgId = DEFAULT_ORG, now = new Date()) { return { month: this.q.totals.get(orgId, monthStart(now)), day: this.q.totals.get(orgId, dayStart(now)), byModel: this.q.byModel.all(orgId, monthStart(now)) }; }
  close() { this.db.close(); }
}

// --- alert de-duplication -------------------------------------------------
Store.prototype.lastEventAt = function (keyId, type) {
  const row = this.db.prepare('SELECT created_at FROM events WHERE key_id=? AND type=? ORDER BY id DESC LIMIT 1').get(keyId, type);
  return row?.created_at ?? null;
};
