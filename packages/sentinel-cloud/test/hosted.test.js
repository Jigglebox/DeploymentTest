import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { signPayload } from '@jigglebox/shared/stripe';

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));
const form = (o) => new URLSearchParams(o).toString();

test('hosted Sentinel Cloud: org signup, org-scoped projects, per-seat upgrade lifts the project cap, isolation', async (t) => {
  const stripe = { async checkoutSession(p) { this.last = p; return { id: 'cs_s', url: 'https://checkout.stripe.com/c/cs_s' }; } };
  const app = buildServer({ dbPath: ':memory:', mode: 'hosted', sessionSecret: 's'.repeat(32), adminToken: 'root', plan: 'free', publicUrl: 'http://sc.local', stripe,
    billing: { secretKey: 'sk', webhookSecret: 'whsec_s', proPriceId: 'price_seat' } });
  const base = await listen(app.server); t.after(() => app.stop());

  assert.equal((await fetch(base + '/api/projects')).status, 401);
  const su = await fetch(base + '/signup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name: 'Acme Sec', email: 'sec@acme.test', password: 'a long enough password' }) });
  assert.equal(su.status, 303);
  const token = new URL(su.headers.get('location'), base).searchParams.get('org_token');
  assert.match(token, /^sn_org_/);
  const as = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const me = await as('/api/me').then((r) => r.json()); assert.equal(me.org.plan, 'free');

  const p1 = await as('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'agents' }) });
  assert.equal(p1.status, 201);
  const p2 = await as('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'second' }) });
  assert.equal(p2.status, 402, 'free = one project');

  const co = await as('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: 'pro', quantity: 3 }) }).then((r) => r.json());
  assert.equal(co.url, 'https://checkout.stripe.com/c/cs_s'); assert.equal(stripe.last.quantity, 3); assert.equal(stripe.last.metadata.org_id, me.org.id);
  const body = JSON.stringify({ id: 'evt_s1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', customer: 'cus_s', subscription: 'sub_s', metadata: { product: 'sentinel-cloud', plan: 'pro', org_id: me.org.id, quantity: '3' } } } });
  assert.equal((await fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'whsec_s') } })).status, 200);
  assert.equal((await as('/api/me').then((r) => r.json())).org.plan, 'pro');
  assert.equal((await as('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'second' }) })).status, 201, 'pro lifts the cap');
  const metrics = await fetch(base + '/api/metrics', { headers: { authorization: 'Bearer root' } }).then((r) => r.json());
  assert.equal(metrics.revenue.mrr_cents, 3 * 1900); assert.equal(metrics.revenue.paying, 1); assert.equal(metrics.funnel.converted, 1);
  assert.equal((await as('/api/metrics')).status, 401, 'tenants cannot read operator metrics');

  // Seat change via subscription.updated; another org cannot see these projects.
  const upd = JSON.stringify({ id: 'evt_s2', type: 'customer.subscription.updated', data: { object: { id: 'sub_s', status: 'active', items: { data: [{ price: { id: 'price_seat' }, quantity: 5 }] } } } });
  await fetch(base + '/webhooks/stripe', { method: 'POST', body: upd, headers: { 'stripe-signature': signPayload(upd, 'whsec_s') } });
  assert.equal((await fetch(base + '/api/metrics', { headers: { authorization: 'Bearer root' } }).then((r) => r.json())).revenue.mrr_cents, 5 * 1900);
  const su2 = await fetch(base + '/signup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name: 'Other', email: 'o@other.test', password: 'another long password' }) });
  const token2 = new URL(su2.headers.get('location'), base).searchParams.get('org_token');
  const list2 = await fetch(base + '/api/projects', { headers: { authorization: `Bearer ${token2}` } }).then((r) => r.json());
  assert.deepEqual(list2.projects, []);
  const p1id = (await p1.json()).project.id;
  assert.equal((await fetch(base + `/api/projects/${p1id}`, { headers: { authorization: `Bearer ${token2}` } })).status, 404);
  const html = await fetch(base + '/', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
  assert.ok(html.includes('Acme Sec') && html.includes('agents') && html.includes('plan <b>pro</b>'));
});
