import { randomBytes } from 'node:crypto';
import { openDatabase, nowIso } from '@jigglebox/shared/db';

const MIGRATIONS = [
  `CREATE TABLE cases (
     id TEXT PRIMARY KEY,
     account TEXT NOT NULL DEFAULT 'self',
     invoice_id TEXT NOT NULL UNIQUE,
     customer_id TEXT,
     customer_email TEXT,
     customer_name TEXT,
     subscription_id TEXT,
     amount_cents INTEGER NOT NULL,
     currency TEXT NOT NULL DEFAULT 'usd',
     failure_code TEXT,
     failure_message TEXT,
     hard_decline INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'open',
     step_index INTEGER NOT NULL DEFAULT 0,
     next_action_at TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     portal_url TEXT,
     opened_at TEXT NOT NULL,
     recovered_at TEXT,
     closed_at TEXT,
     recovered_by TEXT
   );
   CREATE INDEX cases_due ON cases(status, next_action_at);
   CREATE INDEX cases_customer ON cases(customer_id);
   CREATE INDEX cases_sub ON cases(subscription_id);
   CREATE TABLE actions (
     id INTEGER PRIMARY KEY,
     case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     detail TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX actions_case ON actions(case_id);
   CREATE TABLE stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at TEXT NOT NULL);`,
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     name TEXT,
     email TEXT,
     livemode INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'connected',
     connected_at TEXT NOT NULL
   );
   CREATE TABLE oauth_states (state TEXT PRIMARY KEY, created_at TEXT NOT NULL);`,
  `ALTER TABLE accounts ADD COLUMN platform_customer_id TEXT;
   CREATE TABLE fees (
     id TEXT PRIMARY KEY,
     account TEXT NOT NULL,
     period TEXT NOT NULL,
     recovered_cents INTEGER NOT NULL,
     fee_cents INTEGER NOT NULL,
     currency TEXT NOT NULL DEFAULT 'usd',
     stripe_invoice_id TEXT,
     hosted_invoice_url TEXT,
     status TEXT NOT NULL DEFAULT 'invoiced',
     created_at TEXT NOT NULL,
     paid_at TEXT,
     UNIQUE(account, period)
   );
   CREATE TABLE fee_runs (period TEXT PRIMARY KEY, ran_at TEXT NOT NULL, invoices INTEGER NOT NULL);`,
];

export class Store {
  constructor(dbPath = ':memory:') {
    this.db = openDatabase(dbPath, MIGRATIONS);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      insertCase: p(`INSERT INTO cases (id,account,invoice_id,customer_id,customer_email,customer_name,subscription_id,amount_cents,currency,failure_code,failure_message,hard_decline,status,step_index,next_action_at,attempts,opened_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',0,?,?,?)`),
      byInvoice: p('SELECT * FROM cases WHERE invoice_id=?'),
      byId: p('SELECT * FROM cases WHERE id=?'),
      openBySubscription: p("SELECT * FROM cases WHERE subscription_id=? AND status='open'"),
      openByCustomer: p("SELECT * FROM cases WHERE customer_id=? AND status='open'"),
      due: p("SELECT * FROM cases WHERE status='open' AND next_action_at IS NOT NULL AND next_action_at<=? ORDER BY next_action_at LIMIT 200"),
      list: p('SELECT * FROM cases ORDER BY opened_at DESC LIMIT ?'),
      advance: p('UPDATE cases SET step_index=?, next_action_at=? WHERE id=?'),
      bumpAttempt: p('UPDATE cases SET attempts=attempts+1, failure_code=COALESCE(?,failure_code), failure_message=COALESCE(?,failure_message), hard_decline=MAX(hard_decline,?) WHERE id=?'),
      setPortal: p('UPDATE cases SET portal_url=? WHERE id=?'),
      close: p('UPDATE cases SET status=?, closed_at=?, recovered_at=?, recovered_by=?, next_action_at=NULL WHERE id=?'),
      insertAction: p('INSERT INTO actions (case_id,type,detail,created_at) VALUES (?,?,?,?)'),
      actionsFor: p('SELECT * FROM actions WHERE case_id=? ORDER BY id'),
      seenEvent: p('SELECT 1 FROM stripe_events WHERE id=?'),
      markEvent: p('INSERT OR IGNORE INTO stripe_events (id,type,received_at) VALUES (?,?,?)'),
      stats: p(`SELECT
                  SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_n,
                  SUM(CASE WHEN status='open' THEN amount_cents ELSE 0 END) AS open_cents,
                  SUM(CASE WHEN status='recovered' THEN 1 ELSE 0 END) AS recovered_n,
                  SUM(CASE WHEN status='recovered' THEN amount_cents ELSE 0 END) AS recovered_cents,
                  SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) AS lost_n,
                  SUM(CASE WHEN status='lost' THEN amount_cents ELSE 0 END) AS lost_cents,
                  SUM(CASE WHEN status='recovered' AND recovered_at>=? THEN amount_cents ELSE 0 END) AS recovered_month_cents
                FROM cases`),
    };
  }

  createCase(c) {
    const id = 'rc_' + randomBytes(6).toString('hex');
    this.q.insertCase.run(id, c.account ?? 'self', c.invoiceId, c.customerId ?? null, c.customerEmail ?? null, c.customerName ?? null, c.subscriptionId ?? null,
      c.amountCents, c.currency ?? 'usd', c.failureCode ?? null, c.failureMessage ?? null, c.hardDecline ? 1 : 0, c.nextActionAt ?? null, c.attempts ?? 1, c.openedAt ?? nowIso());
    return this.getCase(id);
  }
  getCase(id) { return this.q.byId.get(id) ?? null; }
  caseByInvoice(invoiceId) { return this.q.byInvoice.get(invoiceId) ?? null; }
  openCasesForSubscription(subId) { return this.q.openBySubscription.all(subId); }
  openCasesForCustomer(custId) { return this.q.openByCustomer.all(custId); }
  dueCases(now = nowIso()) { return this.q.due.all(now); }
  listCases(limit = 200) { return this.q.list.all(limit); }
  advance(id, stepIndex, nextActionAt) { this.q.advance.run(stepIndex, nextActionAt, id); }
  bumpAttempt(id, { failureCode = null, failureMessage = null, hardDecline = false } = {}) { this.q.bumpAttempt.run(failureCode, failureMessage, hardDecline ? 1 : 0, id); }
  setPortalUrl(id, url) { this.q.setPortal.run(url, id); }
  clearHardDecline(id) { this.db.prepare('UPDATE cases SET hard_decline=0 WHERE id=?').run(id); }
  closeCase(id, status, { recoveredBy = null, at = nowIso() } = {}) { this.q.close.run(status, at, status === 'recovered' ? at : null, recoveredBy, id); }
  action(caseId, type, detail = {}) { this.q.insertAction.run(caseId, type, JSON.stringify(detail), nowIso()); }
  actionsFor(caseId) { return this.q.actionsFor.all(caseId).map((a) => ({ ...a, detail: JSON.parse(a.detail ?? '{}') })); }
  seenEvent(id) { return Boolean(this.q.seenEvent.get(id)); }
  markEvent(id, type) { this.q.markEvent.run(id, type, nowIso()); }
  // ---- Stripe Connect accounts ----
  upsertAccount({ id, name = null, email = null, livemode = true }) {
    this.db.prepare(`INSERT INTO accounts (id,name,email,livemode,status,connected_at) VALUES (?,?,?,?,'connected',?)
                     ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name,name), email=COALESCE(excluded.email,email), livemode=excluded.livemode, status='connected'`).run(id, name, email, livemode ? 1 : 0, nowIso());
    return this.getAccount(id);
  }
  getAccount(id) { return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) ?? null; }
  listAccounts() { return this.db.prepare('SELECT * FROM accounts ORDER BY connected_at DESC').all(); }
  disconnectAccount(id) { this.db.prepare("UPDATE accounts SET status='disconnected' WHERE id=?").run(id); }
  newOauthState(state) { this.db.prepare('INSERT INTO oauth_states (state,created_at) VALUES (?,?)').run(state, nowIso()); }
  consumeOauthState(state, maxAgeMs = 15 * 60_000) {
    const row = this.db.prepare('SELECT created_at FROM oauth_states WHERE state=?').get(state);
    this.db.prepare('DELETE FROM oauth_states WHERE state=? OR created_at<?').run(state, new Date(Date.now() - maxAgeMs).toISOString());
    return Boolean(row) && Date.now() - Date.parse(row.created_at) <= maxAgeMs;
  }
  setPlatformCustomer(accountId, customerId) { this.db.prepare('UPDATE accounts SET platform_customer_id=? WHERE id=?').run(customerId, accountId); }
  /** Recovered revenue per account within [from, to) by recovered_at; the basis for a fee invoice. */
  recoveredByAccount(fromIso, toIso) {
    return this.db.prepare("SELECT account, currency, SUM(amount_cents) AS recovered_cents, COUNT(*) AS n FROM cases WHERE status='recovered' AND recovered_at>=? AND recovered_at<? GROUP BY account, currency").all(fromIso, toIso);
  }
  insertFee(f) { this.db.prepare('INSERT INTO fees (id,account,period,recovered_cents,fee_cents,currency,stripe_invoice_id,hosted_invoice_url,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(f.id, f.account, f.period, f.recoveredCents, f.feeCents, f.currency ?? 'usd', f.stripeInvoiceId ?? null, f.hostedInvoiceUrl ?? null, f.status ?? 'invoiced', nowIso()); }
  feeFor(account, period) { return this.db.prepare('SELECT * FROM fees WHERE account=? AND period=?').get(account, period) ?? null; }
  feeByInvoice(invoiceId) { return this.db.prepare('SELECT * FROM fees WHERE stripe_invoice_id=?').get(invoiceId) ?? null; }
  markFee(id, status, paidAt = null) { this.db.prepare('UPDATE fees SET status=?, paid_at=COALESCE(?,paid_at) WHERE id=?').run(status, paidAt, id); }
  listFees(limit = 100) { return this.db.prepare('SELECT * FROM fees ORDER BY period DESC, fee_cents DESC LIMIT ?').all(limit); }
  feeRun(period) { return this.db.prepare('SELECT * FROM fee_runs WHERE period=?').get(period) ?? null; }
  recordFeeRun(period, invoices) { this.db.prepare('INSERT OR REPLACE INTO fee_runs (period,ran_at,invoices) VALUES (?,?,?)').run(period, nowIso(), invoices); }

  /** Recovered revenue and fee per connected account this month: what each merchant owes. */
  statsByAccount(now = new Date()) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    return this.db.prepare(`SELECT account, COUNT(*) AS cases_n,
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_n,
        SUM(CASE WHEN status='recovered' THEN amount_cents ELSE 0 END) AS recovered_cents,
        SUM(CASE WHEN status='recovered' AND recovered_at>=? THEN amount_cents ELSE 0 END) AS recovered_month_cents
      FROM cases GROUP BY account ORDER BY recovered_month_cents DESC`).all(monthStart);
  }

  stats(now = new Date()) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const s = this.q.stats.get(monthStart);
    const closed = (s.recovered_n ?? 0) + (s.lost_n ?? 0);
    return { ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v ?? 0])), recovery_rate: closed ? (s.recovered_n ?? 0) / closed : null };
  }
  close() { this.db.close(); }
}
