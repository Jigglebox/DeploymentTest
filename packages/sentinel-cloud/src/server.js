#!/usr/bin/env node
import { Router, createApp, readJson, readForm, sendJson, sendHtml, redirect, tokenQs, HttpError } from '@jigglebox/shared/http';
import { layout, esc } from '@jigglebox/shared/html';
import { log } from '@jigglebox/shared/log';
import { isMain } from '@jigglebox/shared/runtime';
import { config as defaultConfig, PLAN_LIMITS } from './config.js';
import { Store } from './store.js';
import { Monitor } from './monitor.js';
import { createOps } from '@jigglebox/shared/ops';
import { createTenancy } from '@jigglebox/shared/tenancy';
import { createSubscriptions } from '@jigglebox/shared/subscriptions';
import { Stripe } from '@jigglebox/shared/stripe';

export function buildServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, ops: { ...defaultConfig.ops, ...(overrides.ops ?? {}) }, billing: { ...defaultConfig.billing, ...(overrides.billing ?? {}) } };
  const store = new Store(config.dbPath);
  const monitor = new Monitor({ store, config, fetchImpl: overrides.fetchImpl, now: overrides.now });
  const router = new Router();
  const ops = createOps({ db: store.db, product: 'sentinel-cloud', config: config.ops, fetchImpl: overrides.fetchImpl, now: overrides.now });
  const tenancy = createTenancy({ db: store.db, product: 'Sentinel Cloud', mode: config.mode, adminToken: config.adminToken, sessionSecret: config.sessionSecret, publicUrl: config.publicUrl, defaultPlan: config.plan, tokenPrefix: 'sn_org_',
    onSignup: (org) => ops.track('signup', { tenant: org.id }) });
  tenancy.ensureDefaultOrg();
  tenancy.register(router);
  const stripe = overrides.stripe ?? new Stripe(config.billing.secretKey);
  const billing = createSubscriptions({ product: 'sentinel-cloud', tenancy, stripe, ops, config: { secretKey: config.billing.secretKey, webhookSecret: config.billing.webhookSecret, publicUrl: config.publicUrl, prices: { pro: config.billing.proPriceId } } });
  billing.register(router);
  /** Admin routes act on behalf of an org: the default org in single mode, the signed-in org in hosted mode. Returns the org. */
  const admin = (req, url) => tenancy.requireOrg(req, url);
  const projectOr404 = (org, id) => { const p = store.getProject(id); if (!p || p.org_id !== org.id) throw new HttpError(404, 'project not found'); return p; };
  const q = (url) => (tenancy.hosted ? '' : tokenQs(url, config.adminToken));
  const projectFromBearer = (req) => {
    const raw = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const p = raw ? store.projectByToken(raw) : null;
    if (!p) throw new HttpError(401, 'invalid project token (expected sn_...)');
    return p;
  };

  router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true, mode: config.mode, projects: store.countAllProjects() }));
  ops.register(router, { auth: (req, url) => admin(req, url), navFor: (url) => [{ href: '/' + q(url), label: 'Projects' }, { href: '/growth' + q(url), label: 'Growth' }, { href: '/feedback' + q(url), label: 'Feedback' }],
    mrrFn: () => tenancy.mrr({ pro: config.seatPriceCents }), metricsAuth: (req, url) => tenancy.requireOperator(req, url) });

  // ---- CLI-facing: `mcp-sentinel scan --report <url> --report-token <token>` posts here ----
  router.post('/api/v1/report', async (req, res) => {
    const project = projectFromBearer(req);
    const report = await readJson(req);
    const results = await monitor.ingestReport(project, report);
    ops.track('report_received', { tenant: project.org_id }); ops.track('activated', { tenant: project.org_id, once: true });
    sendJson(res, 200, { project: project.id, results });
  });

  // ---- Admin API ----
  const planOf = (org) => tenancy.plan(org.id);
  const enforceProjectLimit = (org) => { const plan = planOf(org); const limit = PLAN_LIMITS[plan]?.maxProjects ?? 1; if (store.countProjects(org.id) >= limit) throw new HttpError(402, `plan "${plan}" allows ${limit} project(s); upgrade to add more`, { upgrade: `${config.publicUrl}/api/billing/checkout` }); };
  router.get('/api/projects', (req, res, { url }) => { const org = admin(req, url); sendJson(res, 200, { projects: store.listProjects(org.id).map((p) => ({ ...p, servers: store.serversFor(p.id).length, latest: store.latestPerServer(p.id) })) }); });
  router.post('/api/projects', async (req, res, { url }) => {
    const org = admin(req, url);
    enforceProjectLimit(org);
    const body = await readJson(req);
    if (!body.name) throw new HttpError(400, 'name is required');
    const project = store.createProject({ name: String(body.name), alertWebhook: body.alert_webhook ?? null, failOn: ['low', 'medium', 'high'].includes(body.fail_on) ? body.fail_on : 'high', orgId: org.id });
    ops.track('project_created', { tenant: org.id });
    if (!tenancy.hosted) ops.track('signup', { tenant: org.id, once: true });
    sendJson(res, 201, { project, raw_token: project.raw_token, note: 'raw_token is shown once; pass it to the CLI as --report-token' });
  });
  router.get('/api/projects/:id', (req, res, { url, params }) => { const org = admin(req, url); const p = projectOr404(org, params.id); sendJson(res, 200, { project: p, servers: store.serversFor(p.id), latest: store.latestPerServer(p.id), alerts: store.alertsFor(p.id) }); });
  router.put('/api/projects/:id', async (req, res, { url, params }) => { const org = admin(req, url); projectOr404(org, params.id); const b = await readJson(req); sendJson(res, 200, { project: store.updateProject(params.id, { alertWebhook: b.alert_webhook ?? null, failOn: b.fail_on ?? null }) }); });
  router.delete('/api/projects/:id', (req, res, { url, params }) => { const org = admin(req, url); projectOr404(org, params.id); store.deleteProject(params.id); sendJson(res, 200, { deleted: params.id }); });
  router.get('/api/projects/:id/history/:server', (req, res, { url, params }) => { const org = admin(req, url); projectOr404(org, params.id); sendJson(res, 200, { history: store.history(params.id, params.server) }); });
  router.post('/api/projects/:id/servers', async (req, res, { url, params }) => {
    const org = admin(req, url); const p = projectOr404(org, params.id);
    const b = await readJson(req);
    if (!b.name || !/^https?:\/\//.test(b.url ?? '')) throw new HttpError(400, 'name and an http(s) url are required');
    const srv = store.addServer(p.id, { name: String(b.name), url: String(b.url), headers: b.headers ?? {} });
    ops.track('server_registered', { tenant: org.id }); ops.track('activated', { tenant: org.id, once: true });
    sendJson(res, 201, { server: srv, result: b.scan_now === false ? null : await monitor.scanServer(p, srv) });
  });
  router.delete('/api/projects/:id/servers/:name', (req, res, { url, params }) => { const org = admin(req, url); projectOr404(org, params.id); store.deleteServer(params.id, params.name); sendJson(res, 200, { deleted: params.name }); });
  router.post('/api/tick', async (req, res, { url }) => { tenancy.requireOperator(req, url); sendJson(res, 200, { ran: await monitor.tick() }); });

  // ---- Dashboard ----
  const nav = (url) => [{ href: '/' + q(url), label: 'Projects' }, ...(tenancy.hosted ? [] : [{ href: '/growth' + q(url), label: 'Growth' }]), { href: '/feedback' + q(url), label: 'Feedback' }];
  const sevPill = (n) => n >= 3 ? '<span class="pill bad">high</span>' : n === 2 ? '<span class="pill warn">medium</span>' : n === 1 ? '<span class="pill warn">low</span>' : '<span class="pill ok">clean</span>';
  router.get('/', (req, res, { url }) => {
    const org = admin(req, url);
    const projects = store.listProjects(org.id);
    const orgToken = url.searchParams.get('org_token');
    const created = url.searchParams.get('created');
    const body = `${tenancy.accountBar(org)}
      ${created ? `<div class="tile" style="border-color:var(--ok);margin-bottom:20px"><div class="k">Project token — copy it now, it will not be shown again. Pass it to the CLI as <code>--report-token</code>.</div><div class="v"><code>${esc(created)}</code></div></div>` : ''}
      ${orgToken ? `<div class="tile" style="border-color:var(--ok);margin-bottom:20px"><div class="k">Your org API token — copy it now, it will not be shown again. Use it as <code>Authorization: Bearer</code> for the admin API.</div><div class="v"><code>${esc(orgToken)}</code></div></div>` : ''}
      <div class="grid">${projects.map((p) => {
      const latest = store.latestPerServer(p.id);
      const worst = Math.max(0, ...latest.map((s) => s.error ? 3 : s.max_severity));
      const drifted = latest.filter((s) => s.drift.length).length;
      return `<a class="tile" href="/projects/${p.id}${q(url)}" style="text-decoration:none;color:inherit"><div class="k">${esc(p.name)}</div><div class="v">${sevPill(worst)}</div><div class="muted">${latest.length} server(s) · ${drifted} drifted on last scan · token <code>${esc(p.token_prefix)}</code></div></a>`;
    }).join('') || '<div class="tile muted">No projects yet. Create one below.</div>'}</div>
    <form method="post" action="/dashboard/projects${q(url)}" class="tile" style="margin-top:16px"><input name="name" placeholder="project name" required> <input name="alert_webhook" placeholder="alert webhook URL (optional)" style="width:320px"> <select name="fail_on"><option value="high">alert on high</option><option value="medium">alert on medium+</option><option value="low">alert on everything</option></select> <button>Create project</button>
      <span class="muted">Plan: ${esc(planOf(org))} (${PLAN_LIMITS[planOf(org)]?.maxProjects === Infinity ? 'unlimited' : PLAN_LIMITS[planOf(org)]?.maxProjects ?? 1} project(s))</span>${planOf(org) === 'free' && tenancy.hosted ? ` · <form class="inline" method="post" action="/dashboard/upgrade"><input name="seats" type="number" min="1" max="500" value="1" style="width:70px"> seats <button class="secondary">Upgrade · $${(config.seatPriceCents / 100).toFixed(0)}/seat/mo</button></form>` : ''}</form>
    <h2>Report from CI</h2><div class="tile"><pre><code>npx mcp-sentinel scan .mcp.json --report ${esc(config.publicUrl)}/api/v1/report --report-token sn_...</code></pre><p class="muted">Each report is stored, compared with the previous one for the same server, and your webhook is called on drift or new findings. Register HTTP MCP servers on a project and Sentinel Cloud re-scans them every ${Math.round(config.scanIntervalSec / 60)} minutes on its own.</p></div>`;
    sendHtml(res, layout({ title: 'Sentinel Cloud', product: 'Sentinel Cloud', nav: nav(url), body }));
  });
  router.get('/projects/:id', (req, res, { url, params }) => {
    const org = admin(req, url);
    const p = projectOr404(org, params.id);
    const latest = store.latestPerServer(p.id);
    const alerts = store.alertsFor(p.id, 30);
    const body = `${tenancy.accountBar(org)}<p><a href="/${q(url)}">← projects</a></p>
      <h2>${esc(p.name)} <span class="muted">fail-on ${esc(p.fail_on)} · webhook ${p.alert_webhook ? 'set' : 'not set'}</span></h2>
      <table><thead><tr><th>Server</th><th>Status</th><th>Tools</th><th>Findings</th><th>Drift (last scan)</th><th>Source</th><th>Scanned</th></tr></thead><tbody>
      ${latest.map((s) => `<tr><td>${esc(s.server)}</td><td>${s.error ? `<span class="pill bad">unreachable</span>` : sevPill(s.max_severity)}</td><td>${s.tool_count}</td><td>${s.findings.length}</td><td>${s.drift.length ? `<span class="pill bad">${s.drift.map((c) => esc(c.type + ' ' + (c.tool ?? ''))).join(', ')}</span>` : '<span class="muted">none</span>'}</td><td class="muted">${esc(s.source)}</td><td class="muted">${esc(s.created_at.slice(0, 16).replace('T', ' '))}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No scans yet.</td></tr>'}
      </tbody></table>
      <h2>Alerts</h2>
      <table><thead><tr><th>Time</th><th>Server</th><th>Type</th><th>Detail</th></tr></thead><tbody>
      ${alerts.map((a) => `<tr><td class="muted">${esc(a.created_at.slice(0, 16).replace('T', ' '))}</td><td>${esc(a.server)}</td><td><span class="pill ${a.type === 'drift' || a.type === 'unreachable' ? 'bad' : 'warn'}">${esc(a.type)}</span></td><td><code>${esc(JSON.stringify(a.detail)).slice(0, 300)}</code></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No alerts.</td></tr>'}
      </tbody></table>`;
    sendHtml(res, layout({ title: `Sentinel Cloud · ${p.name}`, product: 'Sentinel Cloud', nav: nav(url), body }));
  });

  router.post('/dashboard/projects', async (req, res, { url }) => {
    const org = admin(req, url); enforceProjectLimit(org);
    const f = await readForm(req);
    const project = store.createProject({ name: f.name || 'project', alertWebhook: f.alert_webhook || null, failOn: ['low', 'medium', 'high'].includes(f.fail_on) ? f.fail_on : 'high', orgId: org.id });
    ops.track('project_created', { tenant: org.id });
    const qs = q(url);
    redirect(res, `/${qs}${qs ? '&' : '?'}created=${encodeURIComponent(project.raw_token)}`);
  });
  router.post('/dashboard/upgrade', async (req, res, { url }) => {
    const org = admin(req, url); const f = await readForm(req);
    try { redirect(res, (await billing.createCheckout(org, { plan: 'pro', quantity: f.seats })).url); }
    catch (err) { sendHtml(res, layout({ title: 'Sentinel Cloud', product: 'Sentinel Cloud', nav: nav(url), body: `<div class="tile"><b>Upgrade unavailable: ${esc(err.message)}</b></div>` }), err.status ?? 503); }
  });

  const server = createApp(router, { onError: (err, ctx) => { ops.capture(err, ctx); log.error('unhandled', { error: err.message, stack: err.stack, ...ctx }); } });
  let timer = null;
  const startScheduler = () => { ops.attachProcess(); timer = setInterval(() => monitor.tick().then(() => ops.tick()).catch((e) => log.error('tick failed', { error: e.message })), Math.max(60, Math.min(config.scanIntervalSec, 600)) * 1000); timer.unref(); };
  const stop = () => { if (timer) clearInterval(timer); server.closeAllConnections?.(); server.close(); };
  return { server, store, monitor, ops, config, startScheduler, stop };
}

if (isMain(import.meta.url)) {
  const app = buildServer();
  app.startScheduler();
  app.server.listen(app.config.port, () => log.info('sentinel-cloud listening', { port: app.config.port, mode: app.config.mode, plan: app.config.plan }));
}
