// Self-serve plan upgrades: Stripe Checkout -> webhook -> plan stored in SQLite.
// AGENTFUSE_PLAN (env) remains the fallback for self-hosters without billing.
import { readBody, sendJson, HttpError } from '@jigglebox/shared/http';
import { verifyWebhook } from '@jigglebox/shared/stripe';
import { log } from '@jigglebox/shared/log';

export const PLAN_FOR_PRICE = (config) => ({ [config.billing.proPriceId]: 'pro', [config.billing.teamPriceId]: 'team' });

export function registerBilling(router, { store, config, stripe }) {
  const enabled = Boolean(config.billing.secretKey && config.billing.webhookSecret);
  const auth = (req, url) => {
    if (!config.adminToken) return;
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (bearer !== config.adminToken && url.searchParams.get('token') !== config.adminToken) throw new HttpError(401, 'unauthorized');
  };

  router.get('/api/billing', (req, res, { url }) => {
    auth(req, url);
    sendJson(res, 200, { enabled, plan: store.plan(config.plan), subscription: store.setting('billing') ?? null });
  });

  /** Start an upgrade. Returns the Checkout URL to send the admin to. */
  router.post('/api/billing/checkout', async (req, res, { url }) => {
    auth(req, url);
    if (!enabled) throw new HttpError(503, 'billing not configured (AGENTFUSE_STRIPE_SECRET_KEY / _WEBHOOK_SECRET / _PRO_PRICE_ID / _TEAM_PRICE_ID)');
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const priceId = body.plan === 'team' ? config.billing.teamPriceId : config.billing.proPriceId;
    if (!priceId) throw new HttpError(400, `no price configured for plan ${body.plan ?? 'pro'}`);
    const session = await stripe.checkoutSession({ priceId, successUrl: `${config.publicUrl}/?upgraded=1`, cancelUrl: `${config.publicUrl}/`, customerEmail: body.email, clientReferenceId: 'agentfuse', metadata: { product: 'agentfuse', plan: body.plan ?? 'pro' } });
    sendJson(res, 200, { url: session.url, id: session.id });
  });

  router.post('/api/billing/portal', async (req, res, { url }) => {
    auth(req, url);
    const sub = store.setting('billing');
    if (!sub?.customerId) throw new HttpError(404, 'no subscription on file');
    const session = await stripe.portalSession(sub.customerId, `${config.publicUrl}/`);
    sendJson(res, 200, { url: session.url });
  });

  router.post('/webhooks/stripe', async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    let event;
    try { event = verifyWebhook(raw, req.headers['stripe-signature'], config.billing.webhookSecret); }
    catch (err) { return sendJson(res, 400, { error: err.message }); }
    const obj = event.data?.object ?? {};
    const planFor = PLAN_FOR_PRICE(config);
    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
      const plan = obj.metadata?.plan ?? 'pro';
      store.setSetting('billing', { customerId: obj.customer, subscriptionId: obj.subscription, plan, email: obj.customer_details?.email ?? obj.customer_email ?? null, since: new Date().toISOString() });
      store.setSetting('plan', plan);
      log.info('plan upgraded via checkout', { plan });
    } else if (event.type === 'customer.subscription.updated') {
      const priceId = obj.items?.data?.[0]?.price?.id;
      const plan = planFor[priceId];
      if (plan && ['active', 'trialing', 'past_due'].includes(obj.status)) { store.setSetting('plan', plan); store.setSetting('billing', { ...(store.setting('billing') ?? {}), subscriptionId: obj.id, customerId: obj.customer, plan }); }
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status)) store.setSetting('plan', 'free');
    } else if (event.type === 'customer.subscription.deleted') {
      store.setSetting('plan', 'free');
      log.info('subscription ended; plan reverted to free');
    }
    sendJson(res, 200, { received: true });
  });
}
