import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { signPayload } from '@jigglebox/shared/stripe';
import { fakeUpstream, listen } from './helpers.js';

const MASTER = 'c'.repeat(64);
const form = (o) => new URLSearchParams(o).toString();

test('growth funnel: signup -> activated -> converted -> churned, MRR, lifecycle emails', async (t) => {
  const up = await fakeUpstream(); t.after(() => up.server.close());
  const mailer = { name: 'test', sent: [], async send(m) { this.sent.push(m); return {}; } };
  const clock = { t: Date.parse('2026-10-18T10:00:00Z') };
  const app = buildServer({ dbPath: ':memory:', mode: 'hosted', masterKey: MASTER, adminToken: 'root', allowedUpstreamHosts: ['api.openai.com', '127.0.0.1'], publicUrl: 'http://af.local', mailer, now: () => new Date(clock.t),
    billing: { secretKey: 'sk', webhookSecret: 'whsec_g', proPriceId: 'price_pro', teamPriceId: 'price_team' }, providers: { openai: { baseUrl: up.url, apiKey: '' }, anthropic: { baseUrl: up.url, apiKey: '' } } });
  const base = await listen(app.server); t.after(() => { app.server.closeAllConnections(); app.server.close(); });

  const signup = async (email) => { const r = await fetch(base + '/signup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name: email.split('@')[0], email, password: 'a long enough password' }) }); return { cookie: r.headers.get('set-cookie').split(';')[0], token: new URL(r.headers.get('location'), base).searchParams.get('org_token') }; };
  const a = await signup('a@acme.test'); const b = await signup('b@globex.test'); await signup('c@initech.test');
  assert.equal(mailer.sent.length, 3, 'welcome email per signup'); assert.match(mailer.sent[0].subject, /Welcome to AgentFuse/);

  const asA = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  await asA('/api/providers/openai', { method: 'PUT', body: JSON.stringify({ api_key: 'sk-acme-key-1234', base_url: up.url }) });
  const key = await asA('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'bot' }) }).then((r) => r.json());
  for (let i = 0; i < 2; i++) assert.equal((await fetch(base + '/openai/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key.raw_key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi ' + i }], max_tokens: 5 }) })).status, 200);
  const orgA = (await asA('/api/me').then((r) => r.json())).org.id;
  const hook = (event) => { const body = JSON.stringify(event); return fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'whsec_g') } }); };
  await hook({ id: 'e1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', customer: 'cus_1', subscription: 'sub_1', metadata: { product: 'agentfuse', plan: 'pro', org_id: orgA } } } });

  assert.equal((await fetch(base + '/api/metrics', { headers: { cookie: a.cookie } })).status, 401, 'tenants cannot read operator metrics');
  let m = await fetch(base + '/api/metrics', { headers: { authorization: 'Bearer root' } }).then((r) => r.json());
  assert.deepEqual([m.funnel.signups, m.funnel.activated, m.funnel.converted, m.funnel.churned], [3, 1, 1, 0]);
  assert.equal(m.funnel.activated, 1, 'activation counted once despite two requests');
  assert.equal(m.revenue.mrr_cents, 2900); assert.equal(m.revenue.paying, 1);
  assert.equal(m.last_7d.key_created.events, 1);

  await hook({ id: 'e2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
  m = await fetch(base + '/api/metrics', { headers: { authorization: 'Bearer root' } }).then((r) => r.json());
  assert.equal(m.funnel.churned, 1); assert.equal(m.revenue.mrr_cents, 0);
  const page = await fetch(base + '/growth?token=root').then((r) => r.text());
  assert.ok(page.includes('Signups (all time)') && page.includes('activated'));

  // Lifecycle nudges: org B has no key after 48h; org A had traffic; after 7 days org B gets no second nudge without a key, org with key but no traffic gets one.
  const asB = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' } });
  assert.deepEqual(await app.lifecycle.tick(), { sent: 0 }, 'nothing due yet');
  clock.t += 49 * 3600_000;
  assert.deepEqual(await app.lifecycle.tick(), { sent: 2 }, 'B and C nudged for having no key');
  assert.deepEqual(await app.lifecycle.tick(), { sent: 0 }, 'nudges are once per org');
  await asB('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'idle' }) });
  clock.t += 6 * 86400_000;
  assert.deepEqual(await app.lifecycle.tick(), { sent: 1 }, 'B has a key but no traffic after a week');
  assert.match(mailer.sent.at(-1).subject, /has not seen a request/);
  assert.equal(mailer.sent.filter((e) => e.to === 'a@acme.test').length, 1, 'active org only ever got the welcome');
});
