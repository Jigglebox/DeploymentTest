// Stripe Connect (Standard) onboarding: a merchant clicks "Connect Stripe", approves on stripe.com,
// and RecoverKit can then read their invoices, retry charges and open card-update portals on their behalf.
import { randomBytes } from 'node:crypto';
import { sendJson, sendHtml, redirect, requireToken, HttpError } from '@jigglebox/shared/http';
import { layout, esc } from '@jigglebox/shared/html';
import { log } from '@jigglebox/shared/log';

export function registerConnect(router, { store, stripe, config }) {
  const enabled = () => Boolean(config.stripeClientId && config.stripeSecretKey);
  const callbackUrl = `${config.publicUrl}/connect/callback`;

  /** Where to send a merchant to start onboarding. */
  router.get('/connect/start', (req, res, { url }) => {
    requireToken(req, config.adminToken, url);
    if (!enabled()) throw new HttpError(503, 'Stripe Connect not configured (STRIPE_CLIENT_ID + STRIPE_SECRET_KEY)');
    const state = randomBytes(16).toString('hex');
    store.newOauthState(state);
    const params = new URLSearchParams({ response_type: 'code', client_id: config.stripeClientId, scope: 'read_write', state, redirect_uri: callbackUrl });
    redirect(res, `https://connect.stripe.com/oauth/authorize?${params}`);
  });

  router.get('/connect/callback', async (req, res, { url }) => {
    const page = (title, body, status = 200) => sendHtml(res, layout({ title: 'RecoverKit', product: 'RecoverKit', body: `<div class="tile"><b>${esc(title)}</b><p class="muted">${body}</p></div>` }), status);
    const error = url.searchParams.get('error');
    if (error) return page('Stripe connection cancelled', esc(url.searchParams.get('error_description') ?? error), 400);
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (!code || !state || !store.consumeOauthState(state)) return page('Invalid or expired connection link', 'Start again from the dashboard.', 400);
    let token;
    try { token = await stripe.oauthToken(code); }
    catch (err) { log.warn('oauth exchange failed', { error: err.message }); return page('Stripe rejected the connection', esc(err.message), 502); }
    const acct = await stripe.withAccount(token.stripe_user_id).account().catch(() => ({}));
    const account = store.upsertAccount({ id: token.stripe_user_id, name: acct.business_profile?.name ?? acct.settings?.dashboard?.display_name ?? null, email: acct.email ?? null, livemode: token.livemode !== false });
    log.info('stripe account connected', { account: account.id, livemode: account.livemode });
    page('Stripe connected', `${esc(account.name ?? account.id)} is now protected. Failed payments will show up on the dashboard as they happen. <a href="/">Go to dashboard</a>`);
  });

  router.get('/api/accounts', (req, res, { url }) => { requireToken(req, config.adminToken, url); sendJson(res, 200, { connect_enabled: enabled(), accounts: store.listAccounts(), by_account: store.statsByAccount() }); });
  router.post('/api/accounts/:id/disconnect', (req, res, { url, params }) => { requireToken(req, config.adminToken, url); if (!store.getAccount(params.id)) throw new HttpError(404, 'unknown account'); store.disconnectAccount(params.id); sendJson(res, 200, { disconnected: params.id }); });
}
