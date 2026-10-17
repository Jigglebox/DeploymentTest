import { sendJson, sendHtml, HttpError, readBody, requireToken, tokenQs, redirect } from '@jigglebox/shared/http';
import { layout, esc, money } from '@jigglebox/shared/html';

export function registerAdmin(router, { store, engine, config, fees }) {
  const auth = (req, url) => requireToken(req, config.adminToken, url);
  const q = (url) => tokenQs(url, config.adminToken);
  const caseOr404 = (id) => { const c = store.getCase(id); if (!c) throw new HttpError(404, 'case not found'); return c; };
  const withFee = (s) => ({ ...s, fee_pct: config.feePct, fee_month_cents: Math.round((s.recovered_month_cents ?? 0) * config.feePct / 100) });

  router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true, stripe: Boolean(config.stripeSecretKey), webhook: Boolean(config.stripeWebhookSecret), mailer: engine.mailer.name }));
  router.get('/api/stats', (req, res, { url }) => { auth(req, url); sendJson(res, 200, withFee(store.stats())); });
  router.get('/api/cases', (req, res, { url }) => { auth(req, url); sendJson(res, 200, { cases: store.listCases() }); });
  router.get('/api/cases/:id', (req, res, { url, params }) => { auth(req, url); const c = caseOr404(params.id); sendJson(res, 200, { case: c, actions: store.actionsFor(c.id) }); });
  router.post('/api/cases/:id/retry', async (req, res, { url, params }) => { auth(req, url); const c = caseOr404(params.id); sendJson(res, 200, await engine.retry(c, 'manual')); });
  router.post('/api/cases/:id/email', async (req, res, { url, params }) => { auth(req, url); const c = caseOr404(params.id); const t = url.searchParams.get('template') ?? 'reminder'; await engine.sendEmail(c, t); sendJson(res, 200, { sent: t }); });
  router.post('/api/cases/:id/close', (req, res, { url, params }) => { auth(req, url); caseOr404(params.id); store.closeCase(params.id, 'lost'); store.action(params.id, 'closed', { status: 'lost', by: 'manual' }); sendJson(res, 200, { closed: params.id }); });
  router.post('/api/tick', async (req, res, { url }) => { auth(req, url); sendJson(res, 200, { ran: await engine.tick(), fees: await fees.tick() }); });
  router.get('/api/fees', (req, res, { url }) => { auth(req, url); sendJson(res, 200, { fee_pct: config.feePct, fee_cap_cents: config.feeCapCents, fees: store.listFees() }); });
  router.post('/api/fees/run', async (req, res, { url }) => { auth(req, url); const period = url.searchParams.get('period'); if (!/^\d{4}-\d{2}$/.test(period ?? '')) throw new HttpError(400, 'period=YYYY-MM required'); sendJson(res, 200, { period, results: await fees.run(period) }); });

  const nav = (url) => [{ href: '/' + q(url), label: 'Cases' }, { href: '/docs', label: 'Setup' }, { href: '/feedback' + q(url), label: 'Feedback' }];
  const pill = (s) => `<span class="pill ${s === 'recovered' ? 'ok' : s === 'open' ? 'warn' : 'bad'}">${esc(s)}</span>`;

  router.get('/', (req, res, { url }) => {
    auth(req, url);
    const s = withFee(store.stats());
    const cases = store.listCases();
    const accounts = store.listAccounts();
    const feeRows = store.listFees(50);
    const byAccount = Object.fromEntries(store.statsByAccount().map((r) => [r.account, r]));
    const body = `
      <div class="grid">
        <div class="tile"><div class="k">Recovered this month</div><div class="v">${money(s.recovered_month_cents)}</div></div>
        <div class="tile"><div class="k">Recovered all-time</div><div class="v">${money(s.recovered_cents)}<span class="muted"> · ${s.recovered_n} invoices</span></div></div>
        <div class="tile"><div class="k">At risk (open)</div><div class="v">${money(s.open_cents)}<span class="muted"> · ${s.open_n}</span></div></div>
        <div class="tile"><div class="k">Recovery rate</div><div class="v">${s.recovery_rate == null ? '—' : Math.round(s.recovery_rate * 100) + '%'}</div></div>
        <div class="tile"><div class="k">Your RecoverKit fee (${s.fee_pct}% of recovered)</div><div class="v">${money(s.fee_month_cents)}</div></div>
      </div>
      ${config.stripeClientId ? `<p><a class="btn" href="/connect/start${q(url)}">Connect a Stripe account</a> <span class="muted">${accounts.length} connected</span></p>` : ''}
      ${accounts.length ? `<table style="margin-bottom:20px"><thead><tr><th>Merchant</th><th>Mode</th><th>Status</th><th>Open cases</th><th>Recovered (month)</th><th>Fee owed</th></tr></thead><tbody>
        ${accounts.map((a) => { const st = byAccount[a.id] ?? {}; return `<tr><td>${esc(a.name ?? a.id)}<div class="muted"><code>${esc(a.id)}</code></div></td><td>${a.livemode ? 'live' : 'test'}</td><td>${pill(a.status === 'connected' ? 'recovered' : 'lost').replace('recovered', 'connected').replace('lost', 'disconnected')}</td><td>${st.open_n ?? 0}</td><td>${money(st.recovered_month_cents)}</td><td>${money(Math.round((st.recovered_month_cents ?? 0) * config.feePct / 100))}</td></tr>`; }).join('')}
      </tbody></table>` : ''}
      ${feeRows.length ? `<h2>Fee invoices</h2><table style="margin-bottom:20px"><thead><tr><th>Period</th><th>Merchant</th><th>Recovered</th><th>Fee</th><th>Status</th><th></th></tr></thead><tbody>
        ${feeRows.map((f) => `<tr><td>${esc(f.period)}</td><td>${esc(store.getAccount(f.account)?.name ?? f.account)}</td><td>${money(f.recovered_cents)}</td><td>${money(f.fee_cents)}</td><td><span class="pill ${f.status === 'paid' ? 'ok' : f.status === 'invoiced' ? 'warn' : 'bad'}">${esc(f.status)}</span></td><td>${f.hosted_invoice_url ? `<a href="${esc(f.hosted_invoice_url)}">invoice</a>` : ''}</td></tr>`).join('')}
      </tbody></table>` : ''}
      <table><thead><tr><th>Customer</th><th>Amount</th><th>Status</th><th>Decline</th><th>Step</th><th>Next action</th><th>Opened</th></tr></thead><tbody>
      ${cases.map((c) => `<tr><td><a href="/cases/${c.id}${q(url)}">${esc(c.customer_email ?? c.customer_id ?? '?')}</a></td><td>${money(c.amount_cents)}</td><td>${pill(c.status)}</td>
        <td>${esc(c.failure_code ?? '')}${c.hard_decline ? ' <span class="pill bad">hard</span>' : ''}</td><td>${c.step_index}/${engine.campaign.length}</td>
        <td class="muted">${esc(c.next_action_at?.slice(0, 16).replace('T', ' ') ?? '')}</td><td class="muted">${esc(c.opened_at.slice(0, 10))}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No failed payments yet. Point your Stripe webhook at /webhooks/stripe.</td></tr>'}
      </tbody></table>`;
    sendHtml(res, layout({ title: 'RecoverKit', product: 'RecoverKit', nav: nav(url), body }));
  });

  router.get('/cases/:id', (req, res, { url, params }) => {
    auth(req, url);
    const c = caseOr404(params.id);
    const actions = store.actionsFor(c.id);
    const body = `<p><a href="/${q(url)}">← all cases</a></p>
      <div class="grid">
        <div class="tile"><div class="k">${esc(c.customer_email ?? '')}</div><div class="v">${money(c.amount_cents)} ${pill(c.status)}</div></div>
        <div class="tile"><div class="k">Decline</div><div class="v" style="font-size:16px">${esc(c.failure_code ?? 'unknown')}${c.hard_decline ? ' (hard: retries paused until new card)' : ''}</div><div class="muted">${esc(c.failure_message ?? '')}</div></div>
        <div class="tile"><div class="k">Attempts</div><div class="v">${c.attempts}</div></div>
      </div>
      <p><code>invoice ${esc(c.invoice_id)}</code> · <code>customer ${esc(c.customer_id ?? '')}</code> · <code>subscription ${esc(c.subscription_id ?? '')}</code>${c.portal_url ? ` · <a href="${esc(c.portal_url)}">card update link</a>` : ''}</p>
      ${c.status === 'open' ? `<p>
        <form class="inline" method="post" action="/dashboard/cases/${c.id}/retry${q(url)}"><button>Retry charge now</button></form>
        <form class="inline" method="post" action="/dashboard/cases/${c.id}/email${q(url)}"><button class="secondary">Send reminder</button></form>
        <form class="inline" method="post" action="/dashboard/cases/${c.id}/close${q(url)}"><button class="secondary">Mark lost</button></form></p>` : ''}
      <h2>Timeline</h2>
      <table><thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${actions.map((a) => `<tr><td class="muted">${esc(a.created_at.slice(0, 19).replace('T', ' '))}</td><td>${esc(a.type)}</td><td><code>${esc(JSON.stringify(a.detail))}</code></td></tr>`).join('')}
      </tbody></table>`;
    sendHtml(res, layout({ title: `RecoverKit · case`, product: 'RecoverKit', nav: nav(url), body }));
  });

  router.get('/docs', (req, res, { url }) => {
    const body = `<h2>Connect Stripe (5 minutes)</h2><div class="tile"><ol>
      <li>Set <code>STRIPE_SECRET_KEY</code> (restricted key with <b>Invoices: write</b>, <b>Customers: read</b>, <b>Billing portal: write</b>).</li>
      <li>In Stripe → Developers → Webhooks, add endpoint <code>${esc(config.publicUrl)}/webhooks/stripe</code> with events: <code>invoice.payment_failed</code>, <code>invoice.paid</code>, <code>invoice.voided</code>, <code>invoice.marked_uncollectible</code>, <code>customer.subscription.deleted</code>, <code>payment_method.attached</code>. Set <code>STRIPE_WEBHOOK_SECRET</code>.</li>
      <li>Set <code>RESEND_API_KEY</code> + <code>RECOVERKIT_FROM_EMAIL</code> to send real emails (otherwise emails are logged, not sent).</li>
      <li>Recommended: in Stripe → Billing → Subscriptions settings, set retries to <b>off</b> or leave Smart Retries on; RecoverKit's retries are idempotent and coexist safely.</li></ol>
      <p>Campaign: ${engine.campaign.map((s) => `day ${s.day}: ${s.close ? 'close as ' + s.close : [s.email && 'email ' + s.email, s.retry && 'retry'].filter(Boolean).join(' + ')}`).join(' → ')}.</p></div>`;
    sendHtml(res, layout({ title: 'RecoverKit · Setup', product: 'RecoverKit', nav: nav(url), body }));
  });

  router.post('/dashboard/cases/:id/retry', async (req, res, { url, params }) => { auth(req, url); await readBody(req); await engine.retry(caseOr404(params.id), 'manual'); redirect(res, `/cases/${params.id}${q(url)}`); });
  router.post('/dashboard/cases/:id/email', async (req, res, { url, params }) => { auth(req, url); await readBody(req); await engine.sendEmail(caseOr404(params.id), 'reminder'); redirect(res, `/cases/${params.id}${q(url)}`); });
  router.post('/dashboard/cases/:id/close', async (req, res, { url, params }) => { auth(req, url); await readBody(req); caseOr404(params.id); store.closeCase(params.id, 'lost'); store.action(params.id, 'closed', { status: 'lost', by: 'manual' }); redirect(res, `/cases/${params.id}${q(url)}`); });
}
