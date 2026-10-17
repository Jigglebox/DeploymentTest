// Getting paid: once a month, invoice each connected merchant for the fee on what RecoverKit recovered.
// Invoices are issued from the platform's own Stripe account (Connect Standard merchants keep their balance),
// emailed by Stripe with its own reminders and dunning, and tracked here until paid.
import { randomBytes } from 'node:crypto';
import { log } from '@jigglebox/shared/log';

export const periodOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
export const previousPeriod = (now) => periodOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
export function periodBounds(period) {
  const [y, m] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
}
export const feeFor = (recoveredCents, { feePct, feeCapCents = 0 }) => { const raw = Math.round(recoveredCents * feePct / 100); return feeCapCents > 0 ? Math.min(raw, feeCapCents) : raw; };

export class FeeBilling {
  constructor({ store, stripe, config, now = () => new Date(), ops = null }) { Object.assign(this, { store, stripe, config, now, ops }); }

  /** Invoice every connected merchant with recoveries in `period`. Idempotent per (account, period). */
  async run(period, { force = false } = {}) {
    const { from, to } = periodBounds(period);
    const results = [];
    for (const row of this.store.recoveredByAccount(from, to)) {
      if (row.account === 'self') { results.push({ account: 'self', skipped: 'self-hosted merchant is not invoiced' }); continue; }
      if (this.store.feeFor(row.account, period)) { results.push({ account: row.account, skipped: 'already invoiced' }); continue; }
      const account = this.store.getAccount(row.account);
      if (!account || (account.status !== 'connected' && !force)) { results.push({ account: row.account, skipped: 'account not connected' }); continue; }
      const feeCents = feeFor(row.recovered_cents, this.config);
      if (feeCents <= 0) { results.push({ account: row.account, skipped: 'zero fee' }); continue; }
      try {
        const customerId = account.platform_customer_id ?? (await this.ensureCustomer(account));
        const desc = `RecoverKit: ${this.config.feePct}% of ${(row.recovered_cents / 100).toFixed(2)} ${row.currency.toUpperCase()} recovered across ${row.n} invoice(s) in ${period}` + (this.config.feeCapCents && feeCents === this.config.feeCapCents ? ' (monthly cap applied)' : '');
        await this.stripe.createInvoiceItem({ customer: customerId, amountCents: feeCents, currency: row.currency, description: desc, metadata: { recoverkit_account: account.id, period } });
        const inv = await this.stripe.createInvoice({ customer: customerId, daysUntilDue: this.config.feeDueDays, description: desc, metadata: { recoverkit_account: account.id, period }, idempotencyKey: `rk-fee-${account.id}-${period}` });
        const finalized = await this.stripe.finalizeInvoice(inv.id);
        this.store.insertFee({ id: 'fee_' + randomBytes(6).toString('hex'), account: account.id, period, recoveredCents: row.recovered_cents, feeCents, currency: row.currency, stripeInvoiceId: finalized.id ?? inv.id, hostedInvoiceUrl: finalized.hosted_invoice_url ?? null, status: 'invoiced' });
        log.info('fee invoiced', { account: account.id, period, feeCents });
        this.ops?.track('fee_invoiced', { tenant: account.id, props: { period, feeCents } }); this.ops?.track('converted', { tenant: account.id, once: true });
        results.push({ account: account.id, invoiced: feeCents, invoice: finalized.id ?? inv.id });
      } catch (err) {
        log.error('fee invoicing failed', { account: account.id, period, error: err.message });
        results.push({ account: account.id, error: err.message });
      }
    }
    this.store.recordFeeRun(period, results.filter((r) => r.invoiced != null).length);
    return results;
  }

  async ensureCustomer(account) {
    const c = await this.stripe.createCustomer({ email: account.email, name: account.name ?? account.id, metadata: { recoverkit_account: account.id } });
    this.store.setPlatformCustomer(account.id, c.id);
    return c.id;
  }

  /** Called from the scheduler: bill the previous month once it is over. */
  async tick() {
    const period = previousPeriod(this.now());
    if (this.store.feeRun(period)) return null;
    return { period, results: await this.run(period) };
  }

  /** Platform invoice lifecycle events (same webhook endpoint as the merchant events). */
  onInvoiceEvent(type, invoice) {
    const fee = this.store.feeByInvoice(invoice.id);
    if (!fee) return false;
    if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') this.store.markFee(fee.id, 'paid', new Date().toISOString());
    else if (type === 'invoice.voided' || type === 'invoice.marked_uncollectible') this.store.markFee(fee.id, type === 'invoice.voided' ? 'void' : 'uncollectible');
    else if (type === 'invoice.payment_failed') this.store.markFee(fee.id, 'overdue');
    return true;
  }
}
