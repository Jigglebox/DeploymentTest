import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { signPayload, verifyWebhook, formEncode } from '@jigglebox/shared/stripe';
import { fakeStripe, failedInvoiceEvent } from './fake-stripe.js';

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));

test('webhook signature verification', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'x' });
  const now = Date.now();
  assert.equal(verifyWebhook(body, signPayload(body, 'whsec_a', now), 'whsec_a', { now }).id, 'evt_1');
  assert.throws(() => verifyWebhook(body, signPayload(body, 'whsec_b', now), 'whsec_a', { now }), /mismatch/);
  assert.throws(() => verifyWebhook(body, signPayload(body, 'whsec_a', now - 600_000), 'whsec_a', { now }), /tolerance/);
  assert.throws(() => verifyWebhook(body + ' ', signPayload(body, 'whsec_a', now), 'whsec_a', { now }), /mismatch/);
});

test('form encoding matches Stripe nesting', () => {
  assert.equal(formEncode({ customer: 'cus_1', flow_data: { type: 'payment_method_update' } }), 'customer=cus_1&flow_data%5Btype%5D=payment_method_update');
});

test('HTTP: webhook -> case -> dashboard -> manual retry', async () => {
  const stripe = fakeStripe(); stripe.seed('in_1', {});
  const app = buildServer({ dbPath: ':memory:', adminToken: 'tok', stripeWebhookSecret: 'whsec_test', stripe, mailer: { name: 'test', sent: [], async send(m) { this.sent.push(m); return {}; } } });
  const base = await listen(app.server);
  const body = JSON.stringify(failedInvoiceEvent());
  const bad = await fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'wrong') } });
  assert.equal(bad.status, 400);
  const ok = await fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'whsec_test') } });
  assert.equal(ok.status, 200);
  const { created } = await ok.json(); assert.equal(created, true);

  assert.equal((await fetch(base + '/api/cases')).status, 401);
  const cases = await fetch(base + '/api/cases', { headers: { authorization: 'Bearer tok' } }).then((r) => r.json());
  assert.equal(cases.cases.length, 1);
  const id = cases.cases[0].id;

  const html = await fetch(base + '/?token=tok').then((r) => r.text());
  assert.ok(html.includes('jane@example.com') && html.includes('RecoverKit'));

  stripe.outcomes.set('in_1', 'paid');
  const retry = await fetch(base + `/api/cases/${id}/retry`, { method: 'POST', headers: { authorization: 'Bearer tok' } }).then((r) => r.json());
  assert.equal(retry.paid, true);
  const stats = await fetch(base + '/api/stats', { headers: { authorization: 'Bearer tok' } }).then((r) => r.json());
  assert.equal(stats.recovered_cents, 4900);
  assert.equal(stats.fee_month_cents, 980, '20% performance fee');
  app.stop();
});
