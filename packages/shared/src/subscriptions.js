// Per-org subscription billing shared by hosted products: Stripe Checkout -> webhook -> plan stored on the org.
// Prices: { pro: price_id, team: price_id }. Seat quantity is supported for per-seat products.
import { readJson, readBody, sendJson, HttpError } from './http.js';
import { verifyWebhook } from './stripe.js';
import { log } from './log.js';

export function createSubscriptions({ product, tenancy, stripe, config, ops = null }) {
  // config: { secretKey, webhookSecret, prices: {plan: priceId}, publicUrl }
  const enabled = () => Boolean(config.secretKey && config.webhookSecret);
  const planForPrice = (priceId) => Object.entries(config.prices ?? {}).find(([, id]) => id && id === priceId)?.[0] ?? null;

  async function createCheckout(org, { plan = 'pro', quantity = 1, email } = {}) {
    if (!enabled()) throw new HttpError(503, 'billing not configured');
    const priceId = config.prices?.[plan];
    if (!priceId) throw new HttpError(400, `no price configured for plan ${plan}`);
    const qty = Math.min(500, Math.max(1, Number(quantity) || 1));
    const session = await stripe.checkoutSession({ priceId, quantity: qty, successUrl: `${config.publicUrl}/?upgraded=1`, cancelUrl: `${config.publicUrl}/`, customerEmail: email ?? org.email ?? undefined, clientReferenceId: org.id, metadata: { product, plan, org_id: org.id, quantity: String(qty) } });
    return { url: session.url, id: session.id };
  }

  function register(router) {
    router.get('/api/billing', (req, res, { url }) => { const org = tenancy.requireOrg(req, url); sendJson(res, 200, { enabled: enabled(), plan: tenancy.plan(org.id), subscription: org.billing ?? null, prices: Object.keys(config.prices ?? {}).filter((p) => config.prices[p]) }); });
    router.post('/api/billing/checkout', async (req, res, { url }) => { const org = tenancy.requireOrg(req, url); sendJson(res, 200, await createCheckout(org, await readJson(req))); });
    router.post('/api/billing/portal', async (req, res, { url }) => {
      const org = tenancy.requireOrg(req, url);
      if (!org.billing?.customerId) throw new HttpError(404, 'no subscription on file');
      sendJson(res, 200, { url: (await stripe.portalSession(org.billing.customerId, `${config.publicUrl}/`)).url });
    });
    router.post('/webhooks/stripe', async (req, res) => {
      const raw = (await readBody(req)).toString('utf8');
      let event;
      try { event = verifyWebhook(raw, req.headers['stripe-signature'], config.webhookSecret); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
      const obj = event.data?.object ?? {};
      if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.metadata?.product === product) {
        const org = tenancy.getOrg(obj.metadata.org_id ?? obj.client_reference_id ?? '');
        if (org) {
          const plan = config.prices?.[obj.metadata.plan] ? obj.metadata.plan : 'pro';
          tenancy.setOrgBilling(org.id, { customerId: obj.customer, subscriptionId: obj.subscription, plan, quantity: Number(obj.metadata.quantity) || 1, email: obj.customer_details?.email ?? obj.customer_email ?? null, since: new Date().toISOString() });
          tenancy.setOrgPlan(org.id, plan);
          ops?.track('converted', { tenant: org.id, props: { plan }, once: true }); ops?.track('plan_changed', { tenant: org.id, props: { plan } });
          log.info('plan upgraded via checkout', { product, org: org.id, plan });
        }
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const org = tenancy.orgBySubscription(obj.id); // other products' subscriptions in the same Stripe account are ignored
        if (org) {
          if (event.type === 'customer.subscription.deleted') { tenancy.setOrgPlan(org.id, 'free'); ops?.track('churned', { tenant: org.id }); log.info('subscription ended; plan reverted to free', { product, org: org.id }); }
          else {
            const item = obj.items?.data?.[0];
            const plan = planForPrice(item?.price?.id);
            if (plan && ['active', 'trialing', 'past_due'].includes(obj.status)) { tenancy.setOrgPlan(org.id, plan); tenancy.setOrgBilling(org.id, { ...org.billing, plan, quantity: item?.quantity ?? org.billing?.quantity ?? 1 }); }
            else if (['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status)) tenancy.setOrgPlan(org.id, 'free');
          }
        }
      }
      sendJson(res, 200, { received: true });
    });
  }
  return { enabled, createCheckout, register };
}
