// Admin JSON API + HTML dashboard. Auth: AGENTFUSE_ADMIN_TOKEN as Bearer header or ?token= query.
import { readJson, readForm, sendJson, sendHtml, requireToken, tokenQs as sharedTokenQs, redirect, HttpError } from '@jigglebox/shared/http';
import { createCheckout } from './billing.js';
import { layout, esc, usd } from '@jigglebox/shared/html';
import { PLAN_LIMITS, DEFAULT_POLICY } from './config.js';

const POLICY_FIELDS = Object.keys(DEFAULT_POLICY).concat(['preflight']);

function sanitizePolicy(input = {}) {
  const out = {};
  for (const f of POLICY_FIELDS) {
    if (!(f in input)) continue;
    const v = input[f];
    if (f === 'allowed_models') out[f] = Array.isArray(v) ? v : (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);
    else if (f === 'preflight') out[f] = v === 'strict' ? 'strict' : 'expected';
    else {
      const n = v === '' || v == null ? null : Number(v);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, `${f} must be a non-negative number`);
      out[f] = n;
    }
  }
  return out;
}

export function registerAdmin(router, { store, config, stripe }) {
  const auth = (req, url) => requireToken(req, config.adminToken, url);
  const keyOr404 = (id) => { const k = store.getKey(id); if (!k) throw new HttpError(404, 'key not found'); return k; };
  const tokenQs = (url) => sharedTokenQs(url, config.adminToken);
  const view = (key) => ({ ...key, key_hash: undefined, spend: store.snapshot(key.id, { loopWindowSec: key.policy.loop_window_sec }) });

  router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true, keys: store.countKeys() }));

  // ---- JSON API ----
  router.get('/api/keys', (req, res, { url }) => { auth(req, url); sendJson(res, 200, { keys: store.listKeys().map(view) }); });
  router.post('/api/keys', async (req, res, { url }) => {
    auth(req, url);
    const body = await readJson(req);
    const plan = store.plan(config.plan); const limit = PLAN_LIMITS[plan]?.maxKeys ?? PLAN_LIMITS.free.maxKeys;
    if (store.countKeys() >= limit) throw new HttpError(402, `plan "${plan}" allows ${limit} keys; upgrade to add more`, { upgrade: `${config.publicUrl}/api/billing/checkout` });
    if (!body.name) throw new HttpError(400, 'name is required');
    const key = store.createKey({ name: String(body.name), policy: sanitizePolicy(body.policy ?? body) });
    sendJson(res, 201, { key: view(key), raw_key: key.raw_key, note: 'raw_key is shown once; store it now' });
  });
  router.get('/api/keys/:id', (req, res, { url, params }) => {
    auth(req, url);
    const key = keyOr404(params.id);
    sendJson(res, 200, { key: view(key), recent: store.recentLedger(key.id, 50) });
  });
  router.put('/api/keys/:id/policy', async (req, res, { url, params }) => {
    auth(req, url); keyOr404(params.id);
    sendJson(res, 200, { key: view(store.updatePolicy(params.id, sanitizePolicy(await readJson(req)))) });
  });
  router.post('/api/keys/:id/resume', (req, res, { url, params }) => { auth(req, url); keyOr404(params.id); store.resume(params.id); sendJson(res, 200, { key: view(store.getKey(params.id)) }); });
  router.post('/api/keys/:id/trip', (req, res, { url, params }) => { auth(req, url); keyOr404(params.id); store.trip(params.id, 'manual', {}); sendJson(res, 200, { key: view(store.getKey(params.id)) }); });
  router.delete('/api/keys/:id', (req, res, { url, params }) => { auth(req, url); keyOr404(params.id); store.deleteKey(params.id); sendJson(res, 200, { deleted: params.id }); });
  router.get('/api/events', (req, res, { url }) => { auth(req, url); sendJson(res, 200, { events: store.recentEvents(100) }); });
  router.get('/api/usage', (req, res, { url }) => { auth(req, url); sendJson(res, 200, store.totals()); });

  // ---- Dashboard ----
  const nav = (url) => [{ href: '/' + tokenQs(url), label: 'Keys' }, { href: '/events' + tokenQs(url), label: 'Events' }, { href: '/docs', label: 'Setup' }];
  const statusPill = (k) => k.status === 'active' ? '<span class="pill ok">active</span>' : k.status === 'tripped' ? `<span class="pill bad">tripped · ${esc(k.tripped_reason)}</span>` : '<span class="pill warn">disabled</span>';

  router.get('/', (req, res, { url }) => {
    auth(req, url);
    const keys = store.listKeys().map(view);
    const totals = store.totals();
    const created = url.searchParams.get('created');
    const q = tokenQs(url);
    const rows = keys.map((k) => {
      const b = k.policy.monthly_budget_usd;
      const pct = b ? Math.min(100, (k.spend.monthUsd / b) * 100) : 0;
      const cls = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '';
      return `<tr><td><a href="/keys/${k.id}${q}">${esc(k.name)}</a><div class="muted"><code>${esc(k.key_prefix)}</code></div></td>
        <td>${statusPill(k)}</td>
        <td>${usd(k.spend.monthUsd)} / ${b == null ? '∞' : usd(b)}<div class="bar"><i class="${cls}" style="width:${pct}%"></i></div></td>
        <td>${usd(k.spend.dayUsd)}</td><td>${k.spend.requestsLastMinute}/min</td>
        <td>${k.status === 'tripped' ? `<form class="inline" method="post" action="/dashboard/keys/${k.id}/resume${q}"><button>Resume</button></form>` : `<form class="inline" method="post" action="/dashboard/keys/${k.id}/trip${q}"><button class="secondary">Trip</button></form>`}</td></tr>`;
    }).join('');
    const body = `
      ${created ? `<div class="tile" style="border-color:var(--ok);margin-bottom:20px"><div class="k">New key created — copy it now, it will not be shown again</div><div class="v"><code>${esc(created)}</code></div></div>` : ''}
      <div class="grid">
        <div class="tile"><div class="k">Spend this month</div><div class="v">${usd(totals.month.usd)}</div></div>
        <div class="tile"><div class="k">Spend today</div><div class="v">${usd(totals.day.usd)}</div></div>
        <div class="tile"><div class="k">Requests this month</div><div class="v">${totals.month.n}</div></div>
        <div class="tile"><div class="k">Keys tripped</div><div class="v">${keys.filter((k) => k.status === 'tripped').length}</div></div>
      </div>
      <table><thead><tr><th>Agent key</th><th>State</th><th>Month</th><th>Today</th><th>Rate</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No keys yet. Create one below.</td></tr>'}</tbody></table>
      <h2>Create agent key</h2>
      <form method="post" action="/dashboard/keys${q}" class="tile">
        <p><input name="name" placeholder="name, e.g. research-agent" required> <input name="monthly_budget_usd" type="number" step="0.01" placeholder="monthly $ cap" value="50">
        <input name="daily_budget_usd" type="number" step="0.01" placeholder="daily $ cap (optional)"> <input name="per_run_budget_usd" type="number" step="0.01" placeholder="per-run $ cap (optional)"></p>
        <p><input name="rpm_limit" type="number" placeholder="req/min" value="300"> <input name="loop_max_repeats" type="number" placeholder="identical repeats before trip" value="8"> <input name="loop_window_sec" type="number" placeholder="loop window (s)" value="120">
        <input name="allowed_models" placeholder="allowed model prefixes, comma-separated (optional)"> <select name="preflight"><option value="expected">pre-flight: expected cost</option><option value="strict">pre-flight: worst case (max_tokens)</option></select></p>
        <button>Create key</button> <span class="muted">Plan: ${esc(store.plan(config.plan))} (${PLAN_LIMITS[store.plan(config.plan)]?.maxKeys ?? 3} keys)</span>${store.plan(config.plan) === 'free' ? ` · <form class="inline" method="post" action="/dashboard/upgrade${q}"><button class="secondary">Upgrade to Pro ($29/mo)</button></form>` : ''}
      </form>
      <h2>Top models this month</h2>
      <table><thead><tr><th>Model</th><th>Requests</th><th>Spend</th></tr></thead><tbody>${totals.byModel.map((m) => `<tr><td>${esc(m.model ?? 'unknown')}</td><td>${m.n}</td><td>${usd(m.usd)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No traffic yet</td></tr>'}</tbody></table>`;
    sendHtml(res, layout({ title: 'AgentFuse', product: 'AgentFuse', nav: nav(url), body }));
  });

  router.get('/keys/:id', (req, res, { url, params }) => {
    auth(req, url);
    const k = view(keyOr404(params.id));
    const q = tokenQs(url);
    const recent = store.recentLedger(k.id, 50);
    const body = `
      <p><a href="/${q}">← all keys</a></p>
      <div class="grid">
        <div class="tile"><div class="k">${esc(k.name)}</div><div class="v">${statusPill(k)}</div></div>
        <div class="tile"><div class="k">Month</div><div class="v">${usd(k.spend.monthUsd)}<span class="muted"> / ${k.policy.monthly_budget_usd == null ? '∞' : usd(k.policy.monthly_budget_usd)}</span></div></div>
        <div class="tile"><div class="k">Today</div><div class="v">${usd(k.spend.dayUsd)}<span class="muted"> / ${k.policy.daily_budget_usd == null ? '∞' : usd(k.policy.daily_budget_usd)}</span></div></div>
        <div class="tile"><div class="k">Last hour</div><div class="v">${usd(k.spend.hourUsd)}</div></div>
      </div>
      <p>${k.status === 'tripped' ? `<form class="inline" method="post" action="/dashboard/keys/${k.id}/resume${q}"><button>Resume agent</button></form>` : `<form class="inline" method="post" action="/dashboard/keys/${k.id}/trip${q}"><button class="secondary">Trip (block now)</button></form>`}
      <form class="inline" method="post" action="/dashboard/keys/${k.id}/delete${q}" onsubmit="return confirm('Delete key?')"><button class="secondary">Delete</button></form></p>
      <h2>Policy</h2>
      <form method="post" action="/dashboard/keys/${k.id}/policy${q}" class="tile">
        ${['monthly_budget_usd', 'daily_budget_usd', 'per_run_budget_usd', 'rpm_limit', 'loop_max_repeats', 'loop_window_sec', 'burn_rate_alert_pct'].map((f) => `<label>${f} <input name="${f}" type="number" step="any" value="${k.policy[f] ?? ''}"></label> `).join('')}
        <label>allowed_models <input name="allowed_models" value="${esc((k.policy.allowed_models ?? []).join(','))}"></label>
        <label>preflight <select name="preflight"><option value="expected" ${k.policy.preflight !== 'strict' ? 'selected' : ''}>expected</option><option value="strict" ${k.policy.preflight === 'strict' ? 'selected' : ''}>strict</option></select></label>
        <p><button>Save policy</button></p>
      </form>
      <h2>Recent requests</h2>
      <table><thead><tr><th>Time</th><th>Model</th><th>Run</th><th>In</th><th>Out</th><th>Cost</th><th>Status</th><th>ms</th></tr></thead><tbody>
      ${recent.map((r) => `<tr><td class="muted">${esc(r.created_at.slice(11, 19))}</td><td>${esc(r.model ?? '')}</td><td class="muted">${esc(r.run_id ?? '')}</td><td>${r.input_tokens}</td><td>${r.output_tokens}</td><td>${usd(r.cost_usd)}${r.estimated ? '<span class="muted">~</span>' : ''}</td><td>${r.status >= 400 ? `<span class="pill bad">${r.status}</span>` : `<span class="pill ok">${r.status}</span>`}</td><td class="muted">${r.latency_ms ?? ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No requests yet</td></tr>'}
      </tbody></table>`;
    sendHtml(res, layout({ title: `AgentFuse · ${k.name}`, product: 'AgentFuse', nav: nav(url), body }));
  });

  router.get('/events', (req, res, { url }) => {
    auth(req, url);
    const events = store.recentEvents(100);
    const body = `<table><thead><tr><th>Time</th><th>Key</th><th>Type</th><th>Detail</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td class="muted">${esc(e.created_at)}</td><td>${esc(store.getKey(e.key_id)?.name ?? e.key_id ?? '')}</td><td><span class="pill ${e.type === 'tripped' ? 'bad' : e.type === 'resumed' ? 'ok' : 'warn'}">${esc(e.type)}</span></td><td><code>${esc(JSON.stringify(e.detail))}</code></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No events</td></tr>'}</tbody></table>`;
    sendHtml(res, layout({ title: 'AgentFuse · Events', product: 'AgentFuse', nav: nav(url), body }));
  });

  router.get('/docs', (req, res, { url }) => {
    const base = config.publicUrl;
    const body = `<h2>Point your SDK at AgentFuse</h2>
<div class="tile"><p><b>OpenAI SDK</b> — set base URL and use your AgentFuse key as the API key:</p>
<pre><code>OPENAI_BASE_URL=${esc(base)}/openai/v1
OPENAI_API_KEY=af_live_...</code></pre>
<p><b>Anthropic SDK</b>:</p>
<pre><code>ANTHROPIC_BASE_URL=${esc(base)}/anthropic
ANTHROPIC_API_KEY=af_live_...</code></pre>
<p>Optional: send <code>X-AgentFuse-Run: &lt;run id&gt;</code> to enforce per-run budgets.</p>
<p>Blocked calls return HTTP 402 with <code>error.code</code> = <code>budget_exceeded</code>, <code>budget_would_exceed</code>, <code>loop_detected</code> or <code>circuit_open</code>. Every non-streamed response carries <code>x-agentfuse-cost-usd</code> and <code>x-agentfuse-month-remaining-usd</code>.</p></div>`;
    sendHtml(res, layout({ title: 'AgentFuse · Setup', product: 'AgentFuse', nav: nav(url), body }));
  });

  // ---- Dashboard form posts (urlencoded) ----
  const form = readForm;
  router.post('/dashboard/keys', async (req, res, { url }) => {
    auth(req, url);
    const f = await form(req);
    const plan = store.plan(config.plan); const limit = PLAN_LIMITS[plan]?.maxKeys ?? 3;
    if (store.countKeys() >= limit) throw new HttpError(402, `plan "${plan}" allows ${limit} keys`);
    const key = store.createKey({ name: f.name || 'agent', policy: sanitizePolicy(f) });
    const q = tokenQs(url);
    redirect(res, `/${q}${q ? '&' : '?'}created=${encodeURIComponent(key.raw_key)}`);
  });
  router.post('/dashboard/keys/:id/policy', async (req, res, { url, params }) => { auth(req, url); keyOr404(params.id); store.updatePolicy(params.id, sanitizePolicy(await form(req))); redirect(res, `/keys/${params.id}${tokenQs(url)}`); });
  router.post('/dashboard/keys/:id/resume', (req, res, { url, params }) => { auth(req, url); keyOr404(params.id); store.resume(params.id); redirect(res, `/keys/${params.id}${tokenQs(url)}`); });
  router.post('/dashboard/keys/:id/trip', (req, res, { url, params }) => { auth(req, url); keyOr404(params.id); store.trip(params.id, 'manual', {}); redirect(res, `/keys/${params.id}${tokenQs(url)}`); });
  router.post('/dashboard/keys/:id/delete', (req, res, { url, params }) => { auth(req, url); keyOr404(params.id); store.deleteKey(params.id); redirect(res, `/${tokenQs(url)}`); });
  router.post('/dashboard/upgrade', async (req, res, { url }) => {
    auth(req, url); await readForm(req);
    try { redirect(res, (await createCheckout({ store, config, stripe }, { plan: 'pro' })).url); }
    catch (err) { sendHtml(res, layout({ title: 'AgentFuse', product: 'AgentFuse', nav: nav(url), body: `<div class="tile"><b>Upgrade unavailable: ${esc(err.message)}</b><p class="muted">Hosted instances need AGENTFUSE_STRIPE_SECRET_KEY, AGENTFUSE_STRIPE_WEBHOOK_SECRET and AGENTFUSE_PRO_PRICE_ID. Self-hosters can raise AGENTFUSE_PLAN instead.</p></div>` }), err.status ?? 503); }
  });
}
