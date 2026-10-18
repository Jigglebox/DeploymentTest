// Admin JSON API + HTML dashboard, scoped to the requesting org (see auth.js for who that is).
import { readJson, readForm, sendJson, sendHtml, tokenQs as sharedTokenQs, redirect, HttpError } from '@jigglebox/shared/http';
import { seal } from '@jigglebox/shared/crypto';
import { layout, esc, usd } from '@jigglebox/shared/html';
import { PLAN_LIMITS, DEFAULT_POLICY } from './config.js';
import { providers as PROVIDERS } from './providers.js';

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

export function registerAdmin(router, { store, config, stripe, auth: authz, ops = null, billing }) {
  const auth = (req, url) => authz.requireOrg(req, url);
  /** A key is only visible to the org that owns it. */
  const keyOr404 = (org, id) => { const k = store.getKey(id); if (!k || k.org_id !== org.id) throw new HttpError(404, 'key not found'); return k; };
  const tokenQs = (url) => (authz.hosted ? '' : sharedTokenQs(url, config.adminToken));
  const view = (key) => ({ ...key, key_hash: undefined, spend: store.snapshot(key.id, { loopWindowSec: key.policy.loop_window_sec }) });
  const planOf = (org) => store.plan(org.id, config.plan);
  const enforceKeyLimit = (org) => {
    const plan = planOf(org); const limit = PLAN_LIMITS[plan]?.maxKeys ?? PLAN_LIMITS.free.maxKeys;
    if (store.countKeys(org.id) >= limit) throw new HttpError(402, `plan "${plan}" allows ${limit} keys; upgrade to add more`, { upgrade: `${config.publicUrl}/api/billing/checkout` });
  };

  router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true, mode: config.mode }));

  // ---- JSON API ----
  router.get('/api/keys', (req, res, { url }) => { const org = auth(req, url); sendJson(res, 200, { keys: store.listKeys(org.id).map(view) }); });
  router.post('/api/keys', async (req, res, { url }) => {
    const org = auth(req, url);
    const body = await readJson(req);
    enforceKeyLimit(org);
    if (!body.name) throw new HttpError(400, 'name is required');
    const key = store.createKey({ name: String(body.name), policy: sanitizePolicy(body.policy ?? body), orgId: org.id });
    ops?.track('key_created', { tenant: org.id });
    sendJson(res, 201, { key: view(key), raw_key: key.raw_key, note: 'raw_key is shown once; store it now' });
  });
  router.get('/api/keys/:id', (req, res, { url, params }) => {
    const org = auth(req, url);
    const key = keyOr404(org, params.id);
    sendJson(res, 200, { key: view(key), recent: store.recentLedger(key.id, 50) });
  });
  router.put('/api/keys/:id/policy', async (req, res, { url, params }) => {
    const org = auth(req, url); keyOr404(org, params.id);
    sendJson(res, 200, { key: view(store.updatePolicy(params.id, sanitizePolicy(await readJson(req)))) });
  });
  router.post('/api/keys/:id/resume', (req, res, { url, params }) => { const org = auth(req, url); keyOr404(org, params.id); store.resume(params.id); sendJson(res, 200, { key: view(store.getKey(params.id)) }); });
  router.post('/api/keys/:id/trip', (req, res, { url, params }) => { const org = auth(req, url); keyOr404(org, params.id); store.trip(params.id, 'manual', {}); sendJson(res, 200, { key: view(store.getKey(params.id)) }); });
  router.delete('/api/keys/:id', (req, res, { url, params }) => { const org = auth(req, url); keyOr404(org, params.id); store.deleteKey(params.id); sendJson(res, 200, { deleted: params.id }); });
  router.get('/api/events', (req, res, { url }) => { const org = auth(req, url); sendJson(res, 200, { events: store.recentEvents(org.id, 100) }); });
  router.get('/api/usage', (req, res, { url }) => { const org = auth(req, url); sendJson(res, 200, store.totals(org.id)); });
  router.get('/api/export.csv', (req, res, { url }) => {
    const org = auth(req, url);
    const to = url.searchParams.get('to') ?? new Date().toISOString();
    const from = url.searchParams.get('from') ?? new Date(Date.parse(to) - 30 * 86400_000).toISOString();
    const rows = store.exportLedger(org.id, from, to);
    const cols = ['created_at', 'key_name', 'key_id', 'run_id', 'provider', 'model', 'input_tokens', 'output_tokens', 'cost_usd', 'estimated', 'status', 'latency_ms'];
    // Neutralize spreadsheet formula injection: cells starting with =+-@ or tab/CR get a leading apostrophe.
    const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="agentfuse-${from.slice(0, 10)}-${to.slice(0, 10)}.csv"` });
    res.end(csv);
  });
  // Provider credentials per org (hosted mode). Keys are sealed with the master key; never returned.
  router.get('/api/providers', (req, res, { url }) => { const org = auth(req, url); sendJson(res, 200, { providers: providerStatus(org) }); });
  router.put('/api/providers/:name', async (req, res, { url, params }) => {
    const org = auth(req, url);
    const body = await readJson(req);
    saveProvider(org, params.name, body.api_key, body.base_url);
    sendJson(res, 200, { providers: providerStatus(org) });
  });
  router.delete('/api/providers/:name', (req, res, { url, params }) => { const org = auth(req, url); store.deleteProvider(org.id, params.name); sendJson(res, 200, { providers: providerStatus(org) }); });
  function saveProvider(org, name, apiKey, baseUrl) {
    if (!authz.hosted) throw new HttpError(400, 'single-tenant mode takes provider keys from the environment');
    if (!PROVIDERS[name]) throw new HttpError(400, `unknown provider ${name}`);
    if (!apiKey || String(apiKey).length < 8) throw new HttpError(400, 'api_key is required');
    store.setProvider(org.id, name, { apiKeySealed: seal(String(apiKey).trim(), config.masterKey), baseUrl: baseUrl ? validateUpstream(baseUrl) : null });
  }
  /** A tenant-supplied upstream must be a plain https origin on an allow-listed provider host: no query, fragment, userinfo or internal addresses. */
  function validateUpstream(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { throw new HttpError(400, 'base_url must be an absolute https URL'); }
    const host = u.hostname.toLowerCase();
    const loopback = host === '127.0.0.1' || host === 'localhost';
    if ((u.protocol !== 'https:' && !(loopback && u.protocol === 'http:')) || u.username || u.password || u.search || u.hash) throw new HttpError(400, 'base_url must be https with no credentials, query or fragment');
    const ok = config.allowedUpstreamHosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
    if (!ok) throw new HttpError(400, `base_url host is not an allowed provider host (${config.allowedUpstreamHosts.join(', ')})`);
    return u.origin + u.pathname.replace(/\/+$/, '');
  }
  function providerStatus(org) {
    const own = Object.fromEntries(store.providersFor(org.id).map((p) => [p.provider, p]));
    return Object.keys(PROVIDERS).map((name) => ({ provider: name, configured: authz.hosted ? Boolean(own[name]) : Boolean(config.providers[name]?.apiKey), source: authz.hosted ? (own[name] ? 'org' : null) : 'env', base_url: own[name]?.base_url ?? null, updated_at: own[name]?.updated_at ?? null }));
  }

  // ---- Dashboard ----
  const nav = (url) => [{ href: '/' + tokenQs(url), label: 'Keys' }, { href: '/events' + tokenQs(url), label: 'Events' }, { href: '/docs', label: 'Setup' }, ...(authz.hosted ? [] : [{ href: '/growth' + tokenQs(url), label: 'Growth' }]), { href: '/feedback' + tokenQs(url), label: 'Feedback' }];
  const accountBar = (org) => authz.accountBar(org);
  const statusPill = (k) => k.status === 'active' ? '<span class="pill ok">active</span>' : k.status === 'tripped' ? `<span class="pill bad">tripped · ${esc(k.tripped_reason)}</span>` : '<span class="pill warn">disabled</span>';

  router.get('/', (req, res, { url }) => {
    const org = auth(req, url);
    const keys = store.listKeys(org.id).map(view);
    const totals = store.totals(org.id);
    const created = url.searchParams.get('created');
    const orgToken = url.searchParams.get('org_token');
    const q = tokenQs(url);
    const provs = providerStatus(org);
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
      ${accountBar(org)}
      ${orgToken ? `<div class="tile" style="border-color:var(--ok);margin-bottom:20px"><div class="k">Your org API token — copy it now, it will not be shown again. Use it as <code>Authorization: Bearer</code> for the admin API.</div><div class="v"><code>${esc(orgToken)}</code></div></div>` : ''}
      ${created ? `<div class="tile" style="border-color:var(--ok);margin-bottom:20px"><div class="k">New key created — copy it now, it will not be shown again</div><div class="v"><code>${esc(created)}</code></div></div>` : ''}
      ${authz.hosted ? `<h2 style="margin-top:0">Provider keys</h2><div class="tile">${provs.map((p) => `<form class="inline" method="post" action="/dashboard/providers/${p.provider}" style="display:block;margin-bottom:8px"><b>${esc(p.provider)}</b> ${p.configured ? '<span class="pill ok">configured</span>' : '<span class="pill warn">missing</span>'} <input name="api_key" type="password" placeholder="${p.configured ? 'replace key' : 'paste real API key'}" style="width:320px"> <input name="base_url" placeholder="base URL (optional)" value="${esc(p.base_url ?? '')}"> <button class="secondary">Save</button></form>`).join('')}<p class="muted">Stored encrypted with the server master key; only ever sent to the provider.</p></div>` : ''}
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
        <button>Create key</button> <span class="muted">Plan: ${esc(planOf(org))} (${PLAN_LIMITS[planOf(org)]?.maxKeys ?? 3} keys)</span>${planOf(org) === 'free' ? ` · <form class="inline" method="post" action="/dashboard/upgrade${q}"><button class="secondary">Upgrade to Pro ($29/mo)</button></form>` : ''}
      </form>
      <h2>Top models this month</h2>
      <table><thead><tr><th>Model</th><th>Requests</th><th>Spend</th></tr></thead><tbody>${totals.byModel.map((m) => `<tr><td>${esc(m.model ?? 'unknown')}</td><td>${m.n}</td><td>${usd(m.usd)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No traffic yet</td></tr>'}</tbody></table>`;
    sendHtml(res, layout({ title: 'AgentFuse', product: 'AgentFuse', nav: nav(url), body }));
  });

  router.get('/keys/:id', (req, res, { url, params }) => {
    const org = auth(req, url);
    const k = view(keyOr404(org, params.id));
    const q = tokenQs(url);
    const recent = store.recentLedger(k.id, 50);
    const body = `
      ${accountBar(org)}<p><a href="/${q}">← all keys</a></p>
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
    const org = auth(req, url);
    const events = store.recentEvents(org.id, 100);
    const body = `${accountBar(org)}<table><thead><tr><th>Time</th><th>Key</th><th>Type</th><th>Detail</th></tr></thead><tbody>
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
    const org = auth(req, url);
    const f = await form(req);
    enforceKeyLimit(org);
    const key = store.createKey({ name: f.name || 'agent', policy: sanitizePolicy(f), orgId: org.id });
    ops?.track('key_created', { tenant: org.id });
    const q = tokenQs(url);
    redirect(res, `/${q}${q ? '&' : '?'}created=${encodeURIComponent(key.raw_key)}`);
  });
  router.post('/dashboard/keys/:id/policy', async (req, res, { url, params }) => { const org = auth(req, url); keyOr404(org, params.id); store.updatePolicy(params.id, sanitizePolicy(await form(req))); redirect(res, `/keys/${params.id}${tokenQs(url)}`); });
  router.post('/dashboard/keys/:id/resume', (req, res, { url, params }) => { const org = auth(req, url); keyOr404(org, params.id); store.resume(params.id); redirect(res, `/keys/${params.id}${tokenQs(url)}`); });
  router.post('/dashboard/keys/:id/trip', (req, res, { url, params }) => { const org = auth(req, url); keyOr404(org, params.id); store.trip(params.id, 'manual', {}); redirect(res, `/keys/${params.id}${tokenQs(url)}`); });
  router.post('/dashboard/keys/:id/delete', (req, res, { url, params }) => { const org = auth(req, url); keyOr404(org, params.id); store.deleteKey(params.id); redirect(res, `/${tokenQs(url)}`); });
  router.post('/dashboard/providers/:name', async (req, res, { url, params }) => { const org = auth(req, url); const f = await form(req); saveProvider(org, params.name, f.api_key, f.base_url); redirect(res, `/${tokenQs(url)}`); });
  router.post('/dashboard/upgrade', async (req, res, { url }) => {
    const org = auth(req, url); await readForm(req);
    try { redirect(res, (await billing.createCheckout(org, { plan: 'pro' })).url); }
    catch (err) { sendHtml(res, layout({ title: 'AgentFuse', product: 'AgentFuse', nav: nav(url), body: `<div class="tile"><b>Upgrade unavailable: ${esc(err.message)}</b><p class="muted">Hosted instances need AGENTFUSE_STRIPE_SECRET_KEY, AGENTFUSE_STRIPE_WEBHOOK_SECRET and AGENTFUSE_PRO_PRICE_ID. Self-hosters can raise AGENTFUSE_PLAN instead.</p></div>` }), err.status ?? 503); }
  });
}
