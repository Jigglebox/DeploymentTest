// In-memory Stripe stand-in exposing the same methods the engine calls.
import { StripeError } from '@jigglebox/shared/stripe';

export function fakeStripe() {
  const invoices = new Map();
  const calls = [];
  const api = {
    invoices, calls, boundAccount: null,
    withAccount(id) { const bound = Object.create(api); bound.boundAccount = id && id !== 'self' ? id : null; return bound; },
    async oauthToken(code) { calls.push({ method: 'oauthToken', code }); if (code === 'bad') throw new StripeError(400, { error: { message: 'Authorization code is invalid' } }); return { stripe_user_id: 'acct_merchant1', livemode: false }; },
    customers: [], invoiceItems: [], platformInvoices: [],
    async createCustomer(p) { const c = { id: 'cus_pf_' + (this.customers.length + 1), ...p }; this.customers.push(c); calls.push({ method: 'createCustomer', ...p }); return c; },
    async createInvoiceItem(p) { this.invoiceItems.push(p); calls.push({ method: 'createInvoiceItem', ...p }); return { id: 'ii_' + this.invoiceItems.length }; },
    async createInvoice(p) { const inv = { id: 'in_fee_' + (this.platformInvoices.length + 1), status: 'draft', ...p }; this.platformInvoices.push(inv); calls.push({ method: 'createInvoice', ...p }); return inv; },
    async finalizeInvoice(id) { const inv = this.platformInvoices.find((i) => i.id === id); inv.status = 'open'; inv.hosted_invoice_url = `https://invoice.stripe.com/i/${id}`; calls.push({ method: 'finalizeInvoice', id }); return inv; },
    async account() { return { id: this.boundAccount, email: 'owner@merchant.example', business_profile: { name: 'Merchant One' } }; },
    seed(id, inv) { invoices.set(id, { id, object: 'invoice', paid: false, status: 'open', ...inv }); },
    /** next retry outcome per invoice: 'paid' | { declineCode, message } */
    outcomes: new Map(),
    async invoice(id) { const i = invoices.get(id); if (!i) throw new StripeError(404, { error: { message: `No such invoice: ${id}` } }); return i; },
    async payInvoice(id, idem) {
      calls.push({ method: 'payInvoice', id, idem, account: this.boundAccount });
      const inv = invoices.get(id);
      if (!inv) throw new StripeError(404, { error: { message: `No such invoice: ${id}` } });
      if (inv.paid) throw new StripeError(400, { error: { message: 'Invoice is already paid' } });
      const o = this.outcomes.get(id) ?? { declineCode: 'generic_decline', message: 'Your card was declined.' };
      if (o === 'paid') { inv.paid = true; inv.status = 'paid'; return inv; }
      throw new StripeError(402, { error: { code: 'card_declined', decline_code: o.declineCode, message: o.message } });
    },
    async customer(id) { return { id, email: `${id}@example.com` }; },
    async cardUpdateSession(customer, return_url) { calls.push({ method: 'cardUpdateSession', customer, account: this.boundAccount }); return { url: `https://billing.stripe.com/session/${customer}` }; },
  };
  return api;
}

export const failedInvoiceEvent = (over = {}) => ({
  id: 'evt_' + Math.random().toString(36).slice(2), type: 'invoice.payment_failed',
  data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_1', customer_email: 'jane@example.com', customer_name: 'Jane', subscription: 'sub_1', amount_due: 4900, currency: 'usd', attempt_count: 1, status: 'open',
    last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' }, ...over } },
});
