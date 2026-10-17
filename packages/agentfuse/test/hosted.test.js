import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { signPayload } from '@jigglebox/shared/stripe';
import { seal, unseal, hashPassword, verifyPassword, signToken, verifyToken } from '@jigglebox/shared/crypto';
import { fakeUpstream, listen } from './helpers.js';

const MASTER = 'a'.repeat(64);

test('crypto primitives round-trip and reject tampering', () => {
  const sealed = seal('sk-real-123', MASTER);
  assert.equal(unseal(sealed, MASTER), 'sk-real-123');
  assert.throws(() => unseal(sealed, 'b'.repeat(64)));
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h)); assert.ok(!verifyPassword('wrong', h));
  const t = signToken({ org: 'org_1' }, 'secret');
  assert.equal(verifyToken(t, 'secret').org, 'org_1'); assert.equal(verifyToken(t, 'other'), null); assert.equal(verifyToken(t + 'x', 'secret'), null);
});

test('hosted mode: signup, login, org-scoped keys and provider credentials, per-org billing', async (t) => {
  const up = await fakeUpstream(); t.after(() => up.server.close());
  const stripe = { async checkoutSession(p) { this.last = p; return { id: 'cs_h', url: 'https://checkout.stripe.com/c/cs_h' }; } };
  const app = buildServer({ dbPath: ':memory:', mode: 'hosted', masterKey: MASTER, publicUrl: 'http://af.local', plan: 'free', stripe,
    billing: { secretKey: 'sk_test', webhookSecret: 'whsec_h', proPriceId: 'price_pro', teamPriceId: 'price_team' },
    providers: { openai: { baseUrl: up.url, apiKey: 'env-key-must-not-be-used' }, anthropic: { baseUrl: up.url, apiKey: '' } } });
  const base = await listen(app.server); t.after(() => { app.server.closeAllConnections(); app.server.close(); });

  assert.equal((await fetch(base + '/api/keys')).status, 401, 'no session, no access');
  assert.equal((await fetch(base + '/?x=1', { redirect: 'manual' })).status, 401);

  // Sign up -> session cookie + one-time org token in the redirect.
  const form = (o) => new URLSearchParams(o).toString();
  const su = await fetch(base + '/signup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name: 'Acme', email: 'Ops@Acme.test', password: 'correct horse battery' }) });
  assert.equal(su.status, 303);
  const cookie = su.headers.get('set-cookie').split(';')[0];
  const orgToken = new URL(su.headers.get('location'), base).searchParams.get('org_token');
  assert.match(orgToken, /^af_org_/);
  assert.equal((await fetch(base + '/signup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name: 'Dup', email: 'ops@acme.test', password: 'correct horse battery' }) })).status, 409, 'duplicate email');

  const asCookie = (path, init = {}) => fetch(base + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const asToken = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${orgToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const me = await asCookie('/api/me').then((r) => r.json());
  assert.equal(me.org.email, 'ops@acme.test'); assert.equal(me.org.plan, 'free');
  assert.equal((await asToken('/api/me').then((r) => r.json())).org.id, me.org.id, 'org token works for the API');

  // Login with the password also yields a session.
  const li = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ email: 'ops@acme.test', password: 'correct horse battery' }) });
  assert.equal(li.status, 303);
  assert.equal((await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ email: 'ops@acme.test', password: 'nope-nope-nope' }) })).status, 401);

  // Keys are created under the org; the proxy refuses until the org adds its own provider key (env key is never used).
  const created = await asToken('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'agent-1', policy: { monthly_budget_usd: 100 } }) }).then((r) => r.json());
  const chat = (body) => fetch(base + '/openai/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${created.raw_key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })).status, 502);
  assert.equal((await asToken('/api/providers/openai', { method: 'PUT', body: JSON.stringify({ api_key: 'short' }) })).status, 400);
  const saved = await asToken('/api/providers/openai', { method: 'PUT', body: JSON.stringify({ api_key: 'sk-acme-real-key', base_url: up.url + '/' }) }).then((r) => r.json());
  assert.equal(saved.providers.find((p) => p.provider === 'openai').configured, true);
  assert.ok(!JSON.stringify(saved).includes('sk-acme'), 'secret never echoed');
  assert.equal(app.store.providersFor(me.org.id)[0].api_key_sealed.includes('sk-acme'), false, 'sealed at rest');
  const ok = await chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 });
  assert.equal(ok.status, 200);
  assert.equal(up.calls.at(-1).headers.authorization, 'Bearer sk-acme-real-key', "the org's own key reaches the provider");

  // A second org cannot see or use the first org's keys.
  const su2 = await fetch(base + '/signup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name: 'Globex', email: 'it@globex.test', password: 'another long password' }) });
  const cookie2 = su2.headers.get('set-cookie').split(';')[0];
  const as2 = (path, init = {}) => fetch(base + path, { ...init, headers: { cookie: cookie2, 'content-type': 'application/json' } });
  assert.deepEqual((await as2('/api/keys').then((r) => r.json())).keys, []);
  assert.equal((await as2(`/api/keys/${created.key.id}`)).status, 404);
  assert.equal((await as2(`/api/keys/${created.key.id}/trip`, { method: 'POST' })).status, 404);
  assert.equal((await as2('/api/providers').then((r) => r.json())).providers.find((p) => p.provider === 'openai').configured, false);

  // Billing is per org: checkout carries the org id; the webhook upgrades only that org.
  const co = await asToken('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: 'team' }) }).then((r) => r.json());
  assert.equal(co.url, 'https://checkout.stripe.com/c/cs_h'); assert.equal(stripe.last.clientReferenceId, me.org.id); assert.equal(stripe.last.metadata.org_id, me.org.id);
  const hook = (event) => { const body = JSON.stringify(event); return fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'whsec_h') } }); };
  await hook({ id: 'evt_h1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', customer: 'cus_a', subscription: 'sub_a', client_reference_id: me.org.id, metadata: { product: 'agentfuse', plan: 'team', org_id: me.org.id } } } });
  assert.equal((await asToken('/api/billing').then((r) => r.json())).plan, 'team');
  assert.equal((await as2('/api/billing').then((r) => r.json())).plan, 'free', 'other org untouched');
  for (let i = 0; i < 4; i++) assert.equal((await asToken('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'k' + i }) })).status, 201, 'team plan lifts the cap');
  await hook({ id: 'evt_h2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_a' } } });
  assert.equal((await asToken('/api/billing').then((r) => r.json())).plan, 'free');

  // Dashboard renders for the signed-in org only.
  const html = await asCookie('/').then((r) => r.text());
  assert.ok(html.includes('Acme') && html.includes('agent-1') && !html.includes('Globex'));
  const lo = await fetch(base + '/logout', { method: 'POST', redirect: 'manual', headers: { cookie } });
  assert.match(lo.headers.get('set-cookie'), /Max-Age=0/);
});

test('hosted mode refuses to start without a master key', () => {
  assert.throws(() => buildServer({ dbPath: ':memory:', mode: 'hosted', masterKey: '' }), /AGENTFUSE_MASTER_KEY/);
});
