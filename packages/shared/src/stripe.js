// Minimal Stripe REST client + webhook verification. No SDK: smaller surface, trivially mockable.
import { createHmac, timingSafeEqual } from 'node:crypto';

export class StripeError extends Error {
  constructor(status, body) { super(body?.error?.message ?? `stripe ${status}`); this.status = status; this.code = body?.error?.code; this.declineCode = body?.error?.decline_code; this.body = body; }
}

/** Encode nested objects as Stripe's form style: a[b]=c, arr[0]=x */
export function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') parts.push(formEncode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.filter(Boolean).join('&');
}

export class Stripe {
  constructor(secretKey, { fetchImpl = fetch, baseUrl = 'https://api.stripe.com' } = {}) {
    this.secretKey = secretKey; this.fetch = fetchImpl; this.baseUrl = baseUrl;
  }
  async request(method, path, params, { idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${this.secretKey}`, 'stripe-version': '2025-08-27.basil' };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let url = this.baseUrl + path, body;
    if (method === 'GET' && params) url += '?' + formEncode(params);
    else if (params) { body = formEncode(params); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await this.fetch(url, { method, headers, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new StripeError(res.status, json);
    return json;
  }
  get(path, params) { return this.request('GET', path, params); }
  post(path, params, opts) { return this.request('POST', path, params, opts); }

  // The handful of calls RecoverKit needs.
  invoice(id) { return this.get(`/v1/invoices/${id}`, { 'expand[0]': 'customer', 'expand[1]': 'subscription' }); }
  payInvoice(id, idempotencyKey) { return this.post(`/v1/invoices/${id}/pay`, {}, { idempotencyKey }); }
  customer(id) { return this.get(`/v1/customers/${id}`); }
  /** Hosted page where the customer updates their card; Stripe handles PCI. */
  cardUpdateSession(customerId, returnUrl) {
    return this.post('/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl, flow_data: { type: 'payment_method_update' } });
  }
}

/** Verify Stripe-Signature (t=...,v1=...) over the raw body. */
export function verifyWebhook(rawBody, sigHeader, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret) throw new Error('webhook secret not configured');
  const parts = Object.fromEntries(String(sigHeader ?? '').split(',').map((p) => p.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) throw new Error('malformed Stripe-Signature header');
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) throw new Error('webhook timestamp outside tolerance');
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('webhook signature mismatch');
  return JSON.parse(rawBody);
}

/** Produce a header the way Stripe does; used by tests and the local simulator. */
export function signPayload(rawBody, secret, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

// ---- Subscription billing helpers (used by products that sell plans) ----
Stripe.prototype.checkoutSession = function ({ priceId, successUrl, cancelUrl, customerEmail, clientReferenceId, metadata = {} }) {
  return this.post('/v1/checkout/sessions', { mode: 'subscription', 'line_items[0][price]': priceId, 'line_items[0][quantity]': 1, success_url: successUrl, cancel_url: cancelUrl,
    ...(customerEmail ? { customer_email: customerEmail } : {}), ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}), metadata, allow_promotion_codes: true });
};
Stripe.prototype.portalSession = function (customerId, returnUrl) { return this.post('/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl }); };
