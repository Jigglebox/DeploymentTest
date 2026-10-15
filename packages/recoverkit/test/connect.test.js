import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { signPayload, formEncode } from '@jigglebox/shared/stripe';
import { fakeStripe, failedInvoiceEvent } from './fake-stripe.js';

const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));

test('Connect onboarding: start -> callback stores the account; cases from that account use its Stripe-Account binding', async (t) => {
  const stripe = fakeStripe(); stripe.seed('in_1', {});
  const app = buildServer({ dbPath: ':memory:', stripeSecretKey: 'sk_platform', stripeClientId: 'ca_test', stripeConnectWebhookSecret: 'whsec_connect', publicUrl: 'http://rk.local', stripe,
    mailer: { name: 'test', sent: [], async send(m) { this.sent.push(m); return {}; } } });
  const base = await listen(app.server);
  t.after(() => app.stop());

  const start = await fetch(base + '/connect/start', { redirect: 'manual' });
  assert.equal(start.status, 303);
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.origin + authorize.pathname, 'https://connect.stripe.com/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'ca_test');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://rk.local/connect/callback');
  const state = authorize.searchParams.get('state');

  assert.equal((await fetch(base + `/connect/callback?code=ac_123&state=forged`)).status, 400, 'unknown state rejected');
  const cb = await fetch(base + `/connect/callback?code=ac_123&state=${state}`);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /Merchant One is now protected/);
  assert.equal((await fetch(base + `/connect/callback?code=ac_123&state=${state}`)).status, 400, 'state is single-use');
  const accounts = await fetch(base + '/api/accounts').then((r) => r.json());
  assert.equal(accounts.accounts[0].id, 'acct_merchant1'); assert.equal(accounts.accounts[0].livemode, 0);

  // A Connect webhook (signed with the Connect secret, carrying `account`) opens a case bound to that merchant.
  const ev = { ...failedInvoiceEvent(), account: 'acct_merchant1' };
  const body = JSON.stringify(ev);
  const hook = await fetch(base + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signPayload(body, 'whsec_connect') } });
  assert.equal(hook.status, 200);
  const c = app.store.caseByInvoice('in_1');
  assert.equal(c.account, 'acct_merchant1');
  await app.engine.tick(); // day-0 email -> portal session created as the merchant
  assert.equal(stripe.calls.find((x) => x.method === 'cardUpdateSession').account, 'acct_merchant1');
  stripe.outcomes.set('in_1', 'paid');
  await app.engine.retry(app.store.getCase(c.id), 'manual');
  assert.equal(stripe.calls.find((x) => x.method === 'payInvoice').account, 'acct_merchant1');
  const by = (await fetch(base + '/api/accounts').then((r) => r.json())).by_account;
  assert.equal(by[0].account, 'acct_merchant1'); assert.equal(by[0].recovered_cents, 4900);

  // Merchant revokes access from Stripe.
  const deauth = JSON.stringify({ id: 'evt_deauth', type: 'account.application.deauthorized', account: 'acct_merchant1', data: { object: { id: 'ca_test' } } });
  await fetch(base + '/webhooks/stripe', { method: 'POST', body: deauth, headers: { 'stripe-signature': signPayload(deauth, 'whsec_connect') } });
  assert.equal(app.store.getAccount('acct_merchant1').status, 'disconnected');
});

test('OAuth token exchange posts the code to connect.stripe.com and surfaces Stripe errors', async () => {
  const { Stripe } = await import('@jigglebox/shared/stripe');
  const seen = [];
  const s = new Stripe('sk_platform', { fetchImpl: async (url, init) => { seen.push({ url, body: init.body }); return { ok: true, status: 200, json: async () => ({ stripe_user_id: 'acct_x', livemode: true }) }; } });
  assert.equal((await s.oauthToken('ac_1')).stripe_user_id, 'acct_x');
  assert.equal(seen[0].url, 'https://connect.stripe.com/oauth/token');
  assert.equal(seen[0].body, formEncode({ client_secret: 'sk_platform', grant_type: 'authorization_code', code: 'ac_1' }));
  const bad = new Stripe('sk', { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'code expired' }) }) });
  await assert.rejects(bad.oauthToken('x'), /code expired/);
  assert.equal(s.withAccount('acct_x').account, 'acct_x');
  assert.equal(s.withAccount('self'), s);
});
