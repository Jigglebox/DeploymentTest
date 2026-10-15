import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { signPayload } from '@jigglebox/shared/stripe';
import { listen } from './helpers.js';

test('checkout -> webhook upgrades plan and lifts the key limit; cancellation reverts', async () => {
  const stripe = { calls: [], async checkoutSession(p) { this.calls.push(p); return { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }; } };
  const app = buildServer({ dbPath: ':memory:', plan: 'free', publicUrl: 'http://af.local', stripe,
    billing: { secretKey: 'sk_test', webhookSecret: 'whsec_af', proPriceId: 'price_pro', teamPriceId: 'price_team' } });
  const base = await listen(app.server);
  const mk = (n) => fetch(base + '/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'k' + n }) });
  for (let i = 0; i < 3; i++) assert.equal((await mk(i)).status, 201);
  const blocked = await mk(3);
  assert.equal(blocked.status, 402);
  assert.match((await blocked.json()).upgrade, /\/api\/billing\/checkout$/);

  const co = await fetch(base + '/api/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'pro', email: 'ops@example.com' }) }).then((r) => r.json());
  assert.equal(co.url, 'https://checkout.stripe.com/c/cs_1');
  assert.equal(stripe.calls[0].priceId, 'price_pro');

  const hook = (event) => { const body = JSON.stringify(event); return fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'whsec_af') } }); };
  assert.equal((await hook({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }).then((r) => r.status)), 200);
  assert.equal((await fetch(base + '/webhooks/stripe', { method: 'POST', body: '{}', headers: { 'stripe-signature': signPayload('{}', 'wrong') } })).status, 400);

  await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', customer: 'cus_9', subscription: 'sub_9', metadata: { plan: 'pro' }, customer_details: { email: 'ops@example.com' } } } });
  const billing = await fetch(base + '/api/billing').then((r) => r.json());
  assert.equal(billing.plan, 'pro'); assert.equal(billing.subscription.customerId, 'cus_9');
  assert.equal((await mk(4)).status, 201, 'pro plan allows more keys');

  await hook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_9', customer: 'cus_9', status: 'active', items: { data: [{ price: { id: 'price_team' } }] } } } });
  assert.equal((await fetch(base + '/api/billing').then((r) => r.json())).plan, 'team');
  await hook({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_9' } } });
  assert.equal((await fetch(base + '/api/billing').then((r) => r.json())).plan, 'free');
  app.server.close();
});
