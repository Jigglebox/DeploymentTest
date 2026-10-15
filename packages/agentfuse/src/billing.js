// Self-serve plan upgrades: Stripe Checkout -> webhook -> plan stored in SQLite.
// AGENTFUSE_PLAN (env) remains the fallback for self-hosters without billing.
import { readJson, readBody, sendJson, requireToken, HttpError } from '@jigglebox/shared/http';
import { verifyWebhook } from '@jigglebox/shared/stripe';
import { log } from '@jigglebox/shared/log';

const PRODUCT = 'agentfuse';
const billingEnabled = (config) => Boolean(config.billing.secretKey && config.billing.webhookSecret);
const planForPrice = (config, priceId) => ({ [config.billing.proPriceId]: 'pro', [config.billing.teamPriceId]: 'team' })[priceId] ?? null;

/** Create a Checkout session for an upgrade. Shared by the JSON API and the dashboard button. */
export async function createCheckout({ store, config, stripe }, { plan = 'pro', email } = {}) {
  if (!billingEnabled(config)) throw new HttpError(503, 'billing not configured');
  const priceId = plan === 'team' ? config.billing.teamPriceId : config.billing.proPriceId;
  if (!priceId) throw new HttpError(400, `no price configured for plan ${plan}`);
  const session = await stripe.checkoutSession({ priceId, successUrl: `${config.publicUrl}/?upgraded=1`, cancelUrl: `${config.publicUrl}/`, customerEmail: email, clientReferenceId: PRODUCT, metadata: { product: PRODUCT, plan } });
  return { url: session.url, id: session.id };
}

export function registerBilling(router, { store, config, stripe }) {
  const auth = (req, url) => requireToken(req, config.adminToken, url);

  router.get('/api/billing', (req, res, { url }) => {
    auth(req, url);
    sendJson(res, 200, { enabled: billingEnabled(config), plan: store.plan(config.plan), subscription: store.setting('billing') ?? null });
  });
  router.post('/api/billing/checkout', async (req, res, { url }) => {
    auth(req, url);
    sendJson(res, 200, await createCheckout({ store, config, stripe }, await readJson(req)));
  });
  router.post('/api/billing/portal', async (req, res, { url }) => {
    auth(req, url);
    const sub = store.setting('billing');
    if (!sub?.customerId) throw new HttpError(404, 'no subscription on file');
    sendJson(res, 200, { url: (await stripe.portalSession(sub.customerId, `${config.publicUrl}/`)).url });
  });

  router.post('/webhooks/stripe', async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    let event;
    try { event = verifyWebhook(raw, req.headers['stripe-signature'], config.billing.webhookSecret); }
    catch (err) { return sendJson(res, 400, { error: err.message }); }
    const obj = event.data?.object ?? {};
    const current = store.setting('billing');
    const ours = (sub) => current?.subscriptionId && sub.id === current.subscriptionId; // ignore other products' subscriptions in the same Stripe account

    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.metadata?.product === PRODUCT) {
      const plan = obj.metadata.plan === 'team' ? 'team' : 'pro';
      store.setSetting('billing', { customerId: obj.customer, subscriptionId: obj.subscription, plan, email: obj.customer_details?.email ?? obj.customer_email ?? null, since: new Date().toISOString() });
      store.setSetting('plan', plan);
      log.info('plan upgraded via checkout', { plan });
    } else if (event.type === 'customer.subscription.updated' && ours(obj)) {
      const plan = planForPrice(config, obj.items?.data?.[0]?.price?.id);
      if (plan && ['active', 'trialing', 'past_due'].includes(obj.status)) { store.setSetting('plan', plan); store.setSetting('billing', { ...current, plan }); }
      else if (['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status)) store.setSetting('plan', 'free');
    } else if (event.type === 'customer.subscription.deleted' && ours(obj)) {
      store.setSetting('plan', 'free');
      log.info('subscription ended; plan reverted to free');
    }
    sendJson(res, 200, { received: true });
  });
}
