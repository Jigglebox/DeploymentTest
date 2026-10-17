// Self-serve plan upgrades per org: Stripe Checkout -> webhook -> plan stored on the org.
// AGENTFUSE_PLAN (env) remains the fallback for self-hosters without billing.
import { readJson, readBody, sendJson, HttpError } from '@jigglebox/shared/http';
import { verifyWebhook } from '@jigglebox/shared/stripe';
import { log } from '@jigglebox/shared/log';

const PRODUCT = 'agentfuse';
const billingEnabled = (config) => Boolean(config.billing.secretKey && config.billing.webhookSecret);
const planForPrice = (config, priceId) => ({ [config.billing.proPriceId]: 'pro', [config.billing.teamPriceId]: 'team' })[priceId] ?? null;

/** Create a Checkout session for an org's upgrade. Shared by the JSON API and the dashboard button. */
export async function createCheckout({ config, stripe }, org, { plan = 'pro', email } = {}) {
  if (!billingEnabled(config)) throw new HttpError(503, 'billing not configured');
  const priceId = plan === 'team' ? config.billing.teamPriceId : config.billing.proPriceId;
  if (!priceId) throw new HttpError(400, `no price configured for plan ${plan}`);
  const session = await stripe.checkoutSession({ priceId, successUrl: `${config.publicUrl}/?upgraded=1`, cancelUrl: `${config.publicUrl}/`, customerEmail: email ?? org.email ?? undefined, clientReferenceId: org.id, metadata: { product: PRODUCT, plan, org_id: org.id } });
  return { url: session.url, id: session.id };
}

export function registerBilling(router, { store, config, stripe, auth, ops = null }) {
  router.get('/api/billing', (req, res, { url }) => {
    const org = auth.requireOrg(req, url);
    sendJson(res, 200, { enabled: billingEnabled(config), plan: store.plan(org.id, config.plan), subscription: org.billing ?? null });
  });
  router.post('/api/billing/checkout', async (req, res, { url }) => {
    const org = auth.requireOrg(req, url);
    sendJson(res, 200, await createCheckout({ config, stripe }, org, await readJson(req)));
  });
  router.post('/api/billing/portal', async (req, res, { url }) => {
    const org = auth.requireOrg(req, url);
    if (!org.billing?.customerId) throw new HttpError(404, 'no subscription on file');
    sendJson(res, 200, { url: (await stripe.portalSession(org.billing.customerId, `${config.publicUrl}/`)).url });
  });

  router.post('/webhooks/stripe', async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    let event;
    try { event = verifyWebhook(raw, req.headers['stripe-signature'], config.billing.webhookSecret); }
    catch (err) { return sendJson(res, 400, { error: err.message }); }
    const obj = event.data?.object ?? {};

    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.metadata?.product === PRODUCT) {
      const org = store.getOrg(obj.metadata.org_id ?? obj.client_reference_id ?? '');
      if (org) {
        const plan = obj.metadata.plan === 'team' ? 'team' : 'pro';
        store.setOrgBilling(org.id, { customerId: obj.customer, subscriptionId: obj.subscription, plan, email: obj.customer_details?.email ?? obj.customer_email ?? null, since: new Date().toISOString() });
        store.setOrgPlan(org.id, plan);
        ops?.track('converted', { tenant: org.id, props: { plan }, once: true }); ops?.track('plan_changed', { tenant: org.id, props: { plan } });
        log.info('plan upgraded via checkout', { org: org.id, plan });
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const org = store.orgBySubscription(obj.id); // ignores other products' subscriptions in the same Stripe account
      if (org) {
        if (event.type === 'customer.subscription.deleted') { store.setOrgPlan(org.id, 'free'); ops?.track('churned', { tenant: org.id }); log.info('subscription ended; plan reverted to free', { org: org.id }); }
        else {
          const plan = planForPrice(config, obj.items?.data?.[0]?.price?.id);
          if (plan && ['active', 'trialing', 'past_due'].includes(obj.status)) { store.setOrgPlan(org.id, plan); store.setOrgBilling(org.id, { ...org.billing, plan }); }
          else if (['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status)) store.setOrgPlan(org.id, 'free');
        }
      }
    }
    sendJson(res, 200, { received: true });
  });
}
