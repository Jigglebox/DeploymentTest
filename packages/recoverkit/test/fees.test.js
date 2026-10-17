import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { signPayload } from '@jigglebox/shared/stripe';
import { feeFor, previousPeriod, periodBounds } from '../src/fees.js';
import { fakeStripe } from './fake-stripe.js';

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));

test('fee arithmetic and periods', () => {
  assert.equal(feeFor(10000, { feePct: 20 }), 2000);
  assert.equal(feeFor(100000, { feePct: 20, feeCapCents: 9900 }), 9900);
  assert.equal(previousPeriod(new Date('2026-10-03T00:00:00Z')), '2026-09');
  assert.equal(previousPeriod(new Date('2026-01-15T00:00:00Z')), '2025-12');
  assert.deepEqual(periodBounds('2026-09'), { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
});

test('monthly fee run invoices each connected merchant once; webhook settles it; scheduler bills last month automatically', async (t) => {
  const stripe = fakeStripe();
  const clock = { t: Date.parse('2026-10-02T09:00:00Z') };
  const app = buildServer({ dbPath: ':memory:', adminToken: 'tok', stripeSecretKey: 'sk_platform', stripeWebhookSecret: 'whsec_pf', stripe, now: () => new Date(clock.t), feePct: 20,
    mailer: { name: 'test', sent: [], async send() { return {}; } } });
  const base = await listen(app.server); t.after(() => app.stop());
  const { store } = app;

  store.upsertAccount({ id: 'acct_a', name: 'Acme', email: 'billing@acme.test' });
  store.upsertAccount({ id: 'acct_b', name: 'Globex', email: 'ap@globex.test' });
  const recovered = (account, invoiceId, cents, at) => { const c = store.createCase({ account, invoiceId, customerId: 'cus_x', amountCents: cents, openedAt: at, nextActionAt: at }); store.closeCase(c.id, 'recovered', { recoveredBy: 'test', at }); };
  recovered('acct_a', 'in_a1', 4900, '2026-09-05T10:00:00Z');
  recovered('acct_a', 'in_a2', 12000, '2026-09-20T10:00:00Z');
  recovered('acct_b', 'in_b1', 1000, '2026-09-28T10:00:00Z');
  recovered('acct_a', 'in_a3', 5000, '2026-10-01T10:00:00Z'); // this month: not billed yet
  recovered('self', 'in_s1', 9999, '2026-09-10T10:00:00Z');   // self-hosted: never invoiced

  const run = await fetch(base + '/api/fees/run?period=2026-09', { method: 'POST', headers: { authorization: 'Bearer tok' } }).then((r) => r.json());
  const byAcct = Object.fromEntries(run.results.map((r) => [r.account, r]));
  assert.equal(byAcct.acct_a.invoiced, 3380); // 20% of 16900
  assert.equal(byAcct.acct_b.invoiced, 200);
  assert.equal(byAcct.self.skipped, 'self-hosted merchant is not invoiced');
  assert.equal(stripe.customers.length, 2);
  assert.equal(stripe.calls.find((c) => c.method === 'createInvoice').idempotencyKey, 'rk-fee-acct_a-2026-09');
  assert.match(stripe.invoiceItems[0].description, /20% of 169.00 USD recovered across 2 invoice/);
  assert.equal(store.feeFor('acct_a', '2026-09').status, 'invoiced');
  assert.equal(store.getAccount('acct_a').platform_customer_id, 'cus_pf_1');

  // Re-running the same period creates nothing new.
  const again = await fetch(base + '/api/fees/run?period=2026-09', { method: 'POST', headers: { authorization: 'Bearer tok' } }).then((r) => r.json());
  assert.ok(again.results.every((r) => r.skipped));
  assert.equal(stripe.platformInvoices.length, 2);

  // Stripe tells us the platform invoice was paid (no `account` on the event: it is ours, not a merchant's).
  const feeInvoiceId = store.feeFor('acct_a', '2026-09').stripe_invoice_id;
  const body = JSON.stringify({ id: 'evt_fee_paid', type: 'invoice.paid', data: { object: { id: feeInvoiceId, paid: true } } });
  const hook = await fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'whsec_pf', clock.t) } });
  assert.deepEqual(await hook.json().then((j) => j.fee_invoice), feeInvoiceId);
  assert.equal(store.feeFor('acct_a', '2026-09').status, 'paid');

  const api = await fetch(base + '/api/fees', { headers: { authorization: 'Bearer tok' } }).then((r) => r.json());
  assert.equal(api.fees.length, 2);
  const html = await fetch(base + '/?token=tok').then((r) => r.text());
  assert.ok(html.includes('Fee invoices') && html.includes('$33.80'));

  // Scheduler: October's tick already billed September (run above), so nothing; move to November and it bills October on its own.
  assert.equal(await app.fees.tick(), null);
  clock.t = Date.parse('2026-11-01T06:00:00Z');
  const auto = await app.fees.tick();
  assert.equal(auto.period, '2026-10');
  assert.equal(auto.results.find((r) => r.account === 'acct_a').invoiced, 1000);
  assert.equal(await app.fees.tick(), null, 'runs once per period');
});
