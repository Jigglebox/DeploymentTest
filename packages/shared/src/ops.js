// Operations loop shared by every product: capture errors, collect customer feedback, sync both to GitHub
// issues (deduplicated), and post a periodic digest. Issues are the queue that the scheduled triage session works.
import { createHash, randomBytes } from 'node:crypto';
import { readJson, readForm, sendJson, sendHtml, redirect, HttpError } from './http.js';
import { layout, esc } from './html.js';
import { postWebhook } from './notify.js';
import { log } from './log.js';

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS error_reports (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, message TEXT NOT NULL, stack TEXT, route TEXT,
    count INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, issue_number INTEGER, issue_url TEXT, status TEXT NOT NULL DEFAULT 'open');
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, tenant TEXT, contact TEXT, category TEXT NOT NULL, message TEXT NOT NULL, context TEXT,
    issue_number INTEGER, issue_url TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ops_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS growth_events (id INTEGER PRIMARY KEY, tenant TEXT, name TEXT NOT NULL, props TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS growth_name_time ON growth_events(name, created_at);
  CREATE INDEX IF NOT EXISTS growth_tenant ON growth_events(tenant, name);`;
// Funnel stages every product maps its own events onto: a tenant signs up, does the one thing that proves value, pays.
export const FUNNEL = ['signup', 'activated', 'converted', 'churned'];
const CATEGORIES = ['bug', 'feature', 'billing', 'praise', 'other'];
const nowIso = () => new Date().toISOString();

export function createOps({ db, product, config = {}, fetchImpl = fetch, now = () => new Date() }) {
  db.exec(MIGRATION);
  const q = {
    errByFp: db.prepare('SELECT * FROM error_reports WHERE fingerprint=?'),
    insertErr: db.prepare('INSERT INTO error_reports (id,fingerprint,message,stack,route,count,first_seen,last_seen) VALUES (?,?,?,?,?,1,?,?)'),
    bumpErr: db.prepare('UPDATE error_reports SET count=count+1, last_seen=?, route=COALESCE(?,route) WHERE fingerprint=?'),
    unsyncedErr: db.prepare("SELECT * FROM error_reports WHERE issue_number IS NULL AND status='open' ORDER BY count DESC LIMIT 20"),
    setErrIssue: db.prepare('UPDATE error_reports SET issue_number=?, issue_url=? WHERE id=?'),
    listErr: db.prepare('SELECT * FROM error_reports ORDER BY last_seen DESC LIMIT ?'),
    errSince: db.prepare('SELECT COUNT(*) AS fingerprints, COALESCE(SUM(count),0) AS total FROM error_reports WHERE last_seen>?'),
    newErrSince: db.prepare('SELECT COUNT(*) AS n FROM error_reports WHERE first_seen>?'),
    insertFb: db.prepare('INSERT INTO feedback (id,source,tenant,contact,category,message,context,created_at) VALUES (?,?,?,?,?,?,?,?)'),
    unsyncedFb: db.prepare('SELECT * FROM feedback WHERE issue_number IS NULL ORDER BY created_at LIMIT 20'),
    setFbIssue: db.prepare('UPDATE feedback SET issue_number=?, issue_url=? WHERE id=?'),
    listFb: db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?'),
    fbSince: db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE created_at>?'),
    insertGrowth: db.prepare('INSERT INTO growth_events (tenant,name,props,created_at) VALUES (?,?,?,?)'),
    growthOnce: db.prepare('SELECT 1 FROM growth_events WHERE tenant=? AND name=? LIMIT 1'),
    growthByWeek: db.prepare("SELECT strftime('%Y-%W', created_at) AS week, name, COUNT(*) AS n, COUNT(DISTINCT tenant) AS tenants FROM growth_events WHERE created_at>=? GROUP BY week, name ORDER BY week"),
    growthSince: db.prepare('SELECT name, COUNT(*) AS n, COUNT(DISTINCT tenant) AS tenants FROM growth_events WHERE created_at>? GROUP BY name'),
    growthTotals: db.prepare('SELECT name, COUNT(DISTINCT tenant) AS tenants FROM growth_events GROUP BY name'),
    kvGet: db.prepare('SELECT value FROM ops_kv WHERE key=?'),
    kvSet: db.prepare('INSERT INTO ops_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  };
  const kv = { get: (k) => q.kvGet.get(k)?.value ?? null, set: (k, v) => q.kvSet.run(k, String(v)) };
  const github = config.githubToken && config.githubRepo ? { token: config.githubToken, repo: config.githubRepo, api: config.githubApi ?? 'https://api.github.com' } : null;
  const digestIntervalSec = config.digestIntervalSec ?? 24 * 3600;

  // ---- error capture ----
  function capture(err, ctx = {}) {
    try {
      const message = String(err?.message ?? err).split('\n')[0].slice(0, 300);
      const frame = String(err?.stack ?? '').split('\n').find((l) => /^\s+at /.test(l))?.trim() ?? '';
      const fingerprint = createHash('sha256').update(`${product}|${message.replace(/[0-9a-f]{8,}|\d+/g, '#')}|${frame.replace(/:\d+:\d+\)?$/, '')}`).digest('hex').slice(0, 24);
      const ts = now().toISOString();
      if (q.errByFp.get(fingerprint)) q.bumpErr.run(ts, ctx.route ?? null, fingerprint);
      else q.insertErr.run('err_' + randomBytes(6).toString('hex'), fingerprint, message, String(err?.stack ?? '').slice(0, 4000), ctx.route ?? null, ts, ts);
      return fingerprint;
    } catch (e) { log.error('ops.capture failed', { error: e.message }); return null; }
  }
  let attached = false;
  function attachProcess() {
    if (attached) return; attached = true;
    process.on('uncaughtException', (e) => { capture(e, { route: 'process:uncaughtException' }); log.error('uncaught exception', { error: e.message, stack: e.stack }); });
    process.on('unhandledRejection', (e) => { capture(e, { route: 'process:unhandledRejection' }); log.error('unhandled rejection', { error: e?.message ?? String(e) }); });
  }

  // ---- growth tracking ----
  /** Record a product event. `once: true` records it only the first time for that tenant (e.g. activation). */
  function track(name, { tenant = null, props = null, once = false } = {}) {
    try {
      if (once && tenant && q.growthOnce.get(tenant, name)) return false;
      q.insertGrowth.run(tenant, name, props ? JSON.stringify(props).slice(0, 1000) : null, now().toISOString());
      return true;
    } catch (e) { log.error('ops.track failed', { error: e.message }); return false; }
  }
  /** Funnel + weekly series. `mrrFn` is product-specific: () => ({ mrr_cents, paying }). */
  function metrics({ weeks = 8, mrrFn = null } = {}) {
    const t = now();
    const since30 = new Date(t.getTime() - 30 * 86400_000).toISOString();
    const since7 = new Date(t.getTime() - 7 * 86400_000).toISOString();
    const sinceWeeks = new Date(t.getTime() - weeks * 7 * 86400_000).toISOString();
    const by = (rows) => Object.fromEntries(rows.map((r) => [r.name, { events: r.n, tenants: r.tenants }]));
    const totals = Object.fromEntries(q.growthTotals.all().map((r) => [r.name, r.tenants]));
    const weekly = {};
    for (const r of q.growthByWeek.all(sinceWeeks)) { (weekly[r.week] ??= {})[r.name] = r.tenants; }
    const funnel = { signups: totals.signup ?? 0, activated: totals.activated ?? 0, converted: totals.converted ?? 0, churned: totals.churned ?? 0 };
    funnel.activation_rate = funnel.signups ? funnel.activated / funnel.signups : null;
    funnel.conversion_rate = funnel.activated ? funnel.converted / funnel.activated : null;
    return { product, as_of: t.toISOString(), funnel, last_7d: by(q.growthSince.all(since7)), last_30d: by(q.growthSince.all(since30)), weekly, revenue: mrrFn ? mrrFn() : null };
  }

  // ---- feedback ----
  function feedback({ source = 'dashboard', tenant = null, contact = null, category = 'other', message, context = null }) {
    const text = String(message ?? '').trim();
    if (text.length < 3) throw new HttpError(400, 'message is required');
    if (text.length > 5000) throw new HttpError(400, 'message too long (5000 chars max)');
    const cat = CATEGORIES.includes(category) ? category : 'other';
    const id = 'fb_' + randomBytes(6).toString('hex');
    q.insertFb.run(id, source, tenant, contact ? String(contact).slice(0, 200) : null, cat, text, context ? JSON.stringify(context).slice(0, 2000) : null, now().toISOString());
    log.info('feedback received', { id, category: cat, source });
    return { id, category: cat };
  }

  // ---- GitHub issue sync (deduplicated by local issue_number) ----
  async function ghCreateIssue({ title, body, labels }) {
    const res = await fetchImpl(`${github.api}/repos/${github.repo}/issues`, { method: 'POST', headers: { authorization: `Bearer ${github.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'jigglebox-ops' }, body: JSON.stringify({ title: title.slice(0, 250), body, labels }) });
    if (!res.ok) throw new Error(`github ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  async function sync() {
    if (!github) return { skipped: 'github not configured' };
    const out = { errors: 0, feedback: 0, failures: 0 };
    for (const e of q.unsyncedErr.all()) {
      try {
        const issue = await ghCreateIssue({ title: `[${product}] ${e.message}`, labels: ['auto-error', product], body: `**Automated error report from ${product}**\n\n- fingerprint: \`${e.fingerprint}\`\n- occurrences: ${e.count} (first ${e.first_seen}, last ${e.last_seen})\n- route: \`${e.route ?? 'n/a'}\`\n\n\`\`\`\n${e.stack ?? e.message}\n\`\`\`\n\n_Filed by the ops module; the triage session picks this up._` });
        q.setErrIssue.run(issue.number, issue.html_url, e.id); out.errors++;
      } catch (err) { out.failures++; log.warn('issue sync failed', { error: err.message }); }
    }
    for (const f of q.unsyncedFb.all()) {
      try {
        const issue = await ghCreateIssue({ title: `[${product}] ${f.category}: ${f.message.split('\n')[0].slice(0, 80)}`, labels: ['feedback', f.category, product], body: `**Customer feedback via ${f.source}**\n\n- category: ${f.category}\n- tenant: \`${f.tenant ?? 'n/a'}\`\n- contact: ${f.contact ? '(on file, see product database)' : 'none'}\n- received: ${f.created_at}\n\n> ${f.message.replace(/\n/g, '\n> ')}\n\n${f.context ? `context: \`${f.context}\`` : ''}\n\n_Filed by the ops module; the triage session picks this up._` });
        q.setFbIssue.run(issue.number, issue.html_url, f.id); out.feedback++;
      } catch (err) { out.failures++; log.warn('issue sync failed', { error: err.message }); }
    }
    return out;
  }

  // ---- digest ----
  async function digest(force = false) {
    const last = kv.get('last_digest_at');
    const t = now();
    if (!force && last && t.getTime() - Date.parse(last) < digestIntervalSec * 1000) return null;
    const since = last ?? new Date(t.getTime() - digestIntervalSec * 1000).toISOString();
    const errs = q.errSince.get(since), fresh = q.newErrSince.get(since), fb = q.fbSince.get(since);
    const growth = Object.fromEntries(q.growthSince.all(since).map((r) => [r.name, r.tenants]));
    const summary = { product, since, until: t.toISOString(), errors: { fingerprints: errs.fingerprints, occurrences: errs.total, new_fingerprints: fresh.n }, feedback: fb.n, growth };
    kv.set('last_digest_at', t.toISOString());
    const g = FUNNEL.filter((k) => growth[k]).map((k) => `${growth[k]} ${k}`).join(', ');
    if (errs.total > 0 || fb.n > 0 || g) await postWebhook(config.alertWebhook, { text: `${product} digest since ${since}: ${errs.total} error occurrence(s) across ${errs.fingerprints} signature(s) (${fresh.n} new), ${fb.n} feedback item(s)${g ? `; growth: ${g}` : ''}`, type: 'ops_digest', ...summary }, { fetchImpl });
    return summary;
  }
  async function tick() { const s = await sync(); const d = await digest(); return { sync: s, digest: d }; }

  // ---- routes ----
  const publicHits = new Map();
  function register(router, { auth, navFor = () => [], mrrFn = null, metricsAuth = null }) {
    const money = (c) => (Number(c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
    router.get('/api/metrics', (req, res, { url }) => { (metricsAuth ?? auth)(req, url); sendJson(res, 200, metrics({ mrrFn })); });
    router.get('/growth', (req, res, { url }) => {
      (metricsAuth ?? auth)(req, url);
      const m = metrics({ mrrFn });
      const names = Array.from(new Set([...FUNNEL, ...Object.values(m.weekly).flatMap((w) => Object.keys(w))]));
      const body = `<div class="grid">
        <div class="tile"><div class="k">Signups (all time)</div><div class="v">${m.funnel.signups}</div></div>
        <div class="tile"><div class="k">Activated</div><div class="v">${m.funnel.activated}<span class="muted"> · ${pct(m.funnel.activation_rate)} of signups</span></div></div>
        <div class="tile"><div class="k">Paying</div><div class="v">${m.revenue?.paying ?? m.funnel.converted}<span class="muted"> · ${pct(m.funnel.conversion_rate)} of activated</span></div></div>
        <div class="tile"><div class="k">${m.revenue?.label ?? 'MRR'}</div><div class="v">${m.revenue ? money(m.revenue.mrr_cents) : '—'}</div></div>
        <div class="tile"><div class="k">Churned</div><div class="v">${m.funnel.churned}</div></div>
        <div class="tile"><div class="k">Last 7 days</div><div class="v" style="font-size:15px">${FUNNEL.map((k) => `${m.last_7d[k]?.tenants ?? 0} ${k}`).join(' · ')}</div></div>
      </div>
      <h2>Weekly (distinct tenants per event, last 8 weeks)</h2>
      <table><thead><tr><th>Week</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>
      ${Object.entries(m.weekly).map(([w, row]) => `<tr><td class="muted">${esc(w)}</td>${names.map((n) => `<td>${row[n] ?? ''}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${names.length + 1}" class="muted">No events yet.</td></tr>`}
      </tbody></table>
      <p class="muted">Funnel definitions: <b>signup</b> = account created · <b>activated</b> = first moment of value (first proxied request, first recovered invoice, first scan report) · <b>converted</b> = first paid plan or invoice · <b>churned</b> = plan ended or account disconnected.</p>`;
      sendHtml(res, layout({ title: `${product} · Growth`, product, nav: navFor(url), body }));
    });
    const cors = (res) => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'content-type'); res.setHeader('access-control-allow-methods', 'POST, OPTIONS'); };
    router.get('/api/ops/errors', (req, res, { url }) => { auth(req, url); sendJson(res, 200, { github: Boolean(github), errors: q.listErr.all(100) }); });
    router.get('/api/ops/feedback', (req, res, { url }) => { auth(req, url); sendJson(res, 200, { feedback: q.listFb.all(100).map((f) => ({ ...f, context: f.context ? JSON.parse(f.context) : null })) }); });
    router.post('/api/ops/sync', async (req, res, { url }) => { auth(req, url); sendJson(res, 200, { sync: await sync(), digest: await digest(true) }); });
    router.post('/api/feedback', async (req, res, { url }) => {
      const who = auth(req, url);
      const b = await readJson(req);
      sendJson(res, 201, feedback({ source: 'api', tenant: who?.id ?? null, contact: b.contact ?? who?.email ?? null, category: b.category, message: b.message, context: b.context ?? null }));
    });
    router.add('OPTIONS', '/api/feedback/public', (req, res) => { cors(res); res.writeHead(204); res.end(); });
    router.post('/api/feedback/public', async (req, res) => {
      cors(res);
      const ip = req.socket?.remoteAddress ?? 'unknown';
      const bucket = publicHits.get(ip) ?? []; const cutoff = now().getTime() - 3600_000;
      const recent = bucket.filter((t) => t > cutoff); recent.push(now().getTime()); publicHits.set(ip, recent);
      if (recent.length > 10) throw new HttpError(429, 'too many submissions; try again later');
      const b = await readJson(req);
      sendJson(res, 201, feedback({ source: 'site', contact: b.contact ?? null, category: b.category, message: b.message, context: { page: String(b.page ?? '').slice(0, 200) } }));
    });
    router.get('/feedback', (req, res, { url }) => {
      const who = auth(req, url);
      const sent = url.searchParams.get('sent');
      const body = `${sent ? '<div class="tile" style="border-color:var(--ok);margin-bottom:16px"><b>Thanks, received.</b> <span class="muted">It is now in our queue; bugs and billing problems are looked at first.</span></div>' : ''}
        <form method="post" action="/dashboard/feedback${url.search}" class="tile" style="max-width:640px">
          <h2 style="margin-top:0">Tell us what is wrong or missing</h2>
          <p><select name="category">${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select> <input name="contact" placeholder="email for a reply (optional)" value="${esc(who?.email ?? '')}" style="width:280px"></p>
          <p><textarea name="message" rows="6" required style="width:100%" placeholder="What happened, what you expected, and anything that helps us reproduce it."></textarea></p>
          <p><button>Send</button></p></form>`;
      sendHtml(res, layout({ title: `${product} · Feedback`, product, nav: navFor(url), body }));
    });
    router.post('/dashboard/feedback', async (req, res, { url }) => {
      const who = auth(req, url);
      const f = await readForm(req);
      feedback({ source: 'dashboard', tenant: who?.id ?? null, contact: f.contact || who?.email || null, category: f.category, message: f.message });
      redirect(res, `/feedback${url.search ? url.search + '&' : '?'}sent=1`);
    });
  }

  return { capture, attachProcess, feedback, sync, digest, tick, register, track, metrics, kv, github: Boolean(github), CATEGORIES };
}
