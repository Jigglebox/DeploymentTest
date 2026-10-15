// Recovery engine: turns Stripe events into cases and runs the campaign on a clock.
import { nowIso } from '@jigglebox/shared/db';
import { log } from '@jigglebox/shared/log';
import { postWebhook } from '@jigglebox/shared/notify';
import { DEFAULT_CAMPAIGN, HARD_DECLINES } from './config.js';
import { renderEmail } from './emails.js';
import { StripeError } from '@jigglebox/shared/stripe';

const DAY_MS = 86_400_000;
/** Retry/email at 10:00 UTC on the target day: mid-morning US/EU, when banks approve most. */
function scheduleAt(openedAtIso, dayOffset) {
  const d = new Date(Date.parse(openedAtIso) + dayOffset * DAY_MS);
  if (dayOffset === 0) return d.toISOString();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0)).toISOString();
}

export class Engine {
  constructor({ store, stripe, mailer, config, campaign = DEFAULT_CAMPAIGN, now = () => new Date(), fetchImpl = fetch }) {
    Object.assign(this, { store, stripe, mailer, config, campaign, now, fetchImpl });
  }

  // ---------- Stripe webhook ingestion ----------
  async handleEvent(event) {
    if (this.store.seenEvent(event.id)) return { duplicate: true };
    this.store.markEvent(event.id, event.type);
    const obj = event.data?.object ?? {};
    switch (event.type) {
      case 'invoice.payment_failed': return this.onPaymentFailed(obj, event.account);
      case 'invoice.paid':
      case 'invoice.payment_succeeded': return this.onPaid(obj);
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
      case 'invoice.deleted': return this.closeByInvoice(obj.id, 'lost', 'stripe:' + event.type);
      case 'customer.subscription.deleted': return this.onSubscriptionDeleted(obj);
      case 'payment_method.attached':
      case 'customer.updated': return this.onPaymentMethodChanged(obj);
      default: return { ignored: event.type };
    }
  }

  async onPaymentFailed(invoice, account = 'self') {
    const existing = this.store.caseByInvoice(invoice.id);
    const err = invoice.last_payment_error ?? invoice.last_finalization_error ?? {};
    const declineCode = err.decline_code ?? invoice.payment_intent?.last_payment_error?.decline_code ?? null;
    const failureCode = declineCode ?? err.code ?? null;
    const hardDecline = HARD_DECLINES.has(declineCode) || HARD_DECLINES.has(err.code);
    if (existing) {
      if (existing.status === 'open') { this.store.bumpAttempt(existing.id, { failureCode, failureMessage: err.message ?? null, hardDecline }); this.store.action(existing.id, 'stripe_failed_again', { failureCode }); }
      return { case: existing.id, updated: true };
    }
    if (invoice.amount_due === 0 || invoice.status === 'paid') return { ignored: 'nothing due' };
    const customer = typeof invoice.customer === 'object' ? invoice.customer : null;
    const openedAt = this.now().toISOString();
    const c = this.store.createCase({
      account, invoiceId: invoice.id, customerId: customer?.id ?? invoice.customer ?? null,
      customerEmail: invoice.customer_email ?? customer?.email ?? null, customerName: invoice.customer_name ?? customer?.name ?? null,
      subscriptionId: typeof invoice.subscription === 'object' ? invoice.subscription?.id : invoice.subscription ?? null,
      amountCents: invoice.amount_due ?? invoice.amount_remaining ?? 0, currency: invoice.currency ?? 'usd',
      failureCode, failureMessage: err.message ?? null, hardDecline, attempts: invoice.attempt_count ?? 1,
      openedAt, nextActionAt: scheduleAt(openedAt, this.campaign[0].day),
    });
    this.store.action(c.id, 'opened', { failureCode, hardDecline, amountCents: c.amount_cents });
    log.info('recovery case opened', { case: c.id, invoice: invoice.id, amount: c.amount_cents, hardDecline });
    return { case: c.id, created: true };
  }

  async onPaid(invoice) {
    const c = this.store.caseByInvoice(invoice.id);
    if (!c || c.status !== 'open') return { ignored: 'no open case' };
    return this.markRecovered(c, 'stripe:paid');
  }

  async onSubscriptionDeleted(sub) {
    const closed = [];
    for (const c of this.store.openCasesForSubscription(sub.id)) { this.store.closeCase(c.id, 'lost'); this.store.action(c.id, 'closed', { status: 'lost', by: 'subscription_deleted' }); closed.push(c.id); }
    return { closed };
  }

  /** The customer fixed their card: retry immediately instead of waiting for the next step. */
  async onPaymentMethodChanged(obj) {
    const customerId = obj.customer ?? (obj.object === 'customer' ? obj.id : null);
    if (!customerId) return { ignored: 'no customer' };
    const results = [];
    for (const c of this.store.openCasesForCustomer(customerId)) {
      this.store.action(c.id, 'card_updated', {});
      results.push(await this.retry(c, 'card_updated'));
    }
    return { retried: results };
  }

  async closeByInvoice(invoiceId, status, by) {
    const c = this.store.caseByInvoice(invoiceId);
    if (!c || c.status !== 'open') return { ignored: 'no open case' };
    this.store.closeCase(c.id, status); this.store.action(c.id, 'closed', { status, by });
    return { closed: c.id };
  }

  async markRecovered(c, by) {
    this.store.closeCase(c.id, 'recovered', { recoveredBy: by, at: this.now().toISOString() });
    this.store.action(c.id, 'recovered', { by, amountCents: c.amount_cents });
    log.info('recovered', { case: c.id, amount: c.amount_cents, by });
    if (c.customer_email) await this.sendEmail(c, 'recovered').catch((e) => log.warn('thank-you email failed', { error: e.message }));
    postWebhook(this.config.alertWebhook, { text: `RecoverKit recovered ${(c.amount_cents / 100).toFixed(2)} ${c.currency} from ${c.customer_email ?? c.customer_id} (${by})`, type: 'recovered', case: c.id }, { fetchImpl: this.fetchImpl });
    return { recovered: c.id };
  }

  // ---------- Campaign execution ----------
  async retry(c, trigger) {
    const key = `rk-${c.id}-${c.attempts}-${trigger}`;
    try {
      const inv = await this.stripe.payInvoice(c.invoice_id, key);
      this.store.action(c.id, 'retry', { trigger, result: inv.status ?? 'paid' });
      if (inv.paid || inv.status === 'paid') { await this.markRecovered(this.store.getCase(c.id), `retry:${trigger}`); return { paid: true }; }
      return { paid: false, status: inv.status };
    } catch (err) {
      if (err instanceof StripeError && /already paid|No such invoice|not open/i.test(err.message)) {
        // Invoice state moved under us; re-sync from Stripe.
        const inv = await this.stripe.invoice(c.invoice_id).catch(() => null);
        if (inv?.paid) { await this.markRecovered(this.store.getCase(c.id), 'retry:resync'); return { paid: true }; }
        if (inv && ['void', 'uncollectible', 'deleted'].includes(inv.status)) { this.store.closeCase(c.id, 'lost'); return { paid: false, lost: true }; }
      }
      const hard = HARD_DECLINES.has(err.declineCode);
      this.store.bumpAttempt(c.id, { failureCode: err.declineCode ?? err.code ?? null, failureMessage: err.message, hardDecline: hard });
      this.store.action(c.id, 'retry', { trigger, result: 'failed', code: err.declineCode ?? err.code, message: err.message });
      return { paid: false, error: err.message };
    }
  }

  async portalUrl(c) {
    if (c.portal_url) return c.portal_url;
    if (!c.customer_id) return this.config.business.returnUrl;
    try {
      const session = await this.stripe.cardUpdateSession(c.customer_id, this.config.business.returnUrl);
      this.store.setPortalUrl(c.id, session.url);
      return session.url;
    } catch (err) {
      log.warn('portal session failed; falling back to return URL', { error: err.message });
      return this.config.business.returnUrl;
    }
  }

  async sendEmail(c, template) {
    if (!c.customer_email) { this.store.action(c.id, 'email_skipped', { template, reason: 'no email' }); return null; }
    const updateUrl = await this.portalUrl(c);
    const msg = renderEmail(template, { business: this.config.business, amountCents: c.amount_cents, updateUrl, reason: c.failure_message });
    const out = await this.mailer.send({ from: this.config.business.fromEmail, to: c.customer_email, ...msg });
    this.store.action(c.id, 'email', { template, to: c.customer_email, provider: this.mailer.name, id: out?.id });
    return out;
  }

  /** Run one due step for one case. */
  async runStep(c) {
    const step = this.campaign[c.step_index];
    if (!step) { this.store.advance(c.id, c.step_index, null); return { done: true }; }
    if (step.close) { this.store.closeCase(c.id, step.close); this.store.action(c.id, 'closed', { status: step.close, by: 'campaign' }); return { closed: step.close }; }
    const result = { step: c.step_index };
    if (step.retry) {
      if (c.hard_decline) { this.store.action(c.id, 'retry_skipped', { reason: 'hard decline; waiting for new card' }); result.retry = 'skipped'; }
      else { const r = await this.retry(c, `step${c.step_index}`); result.retry = r; if (r.paid) return result; }
    }
    if (step.email) { await this.sendEmail(c, step.email).catch((e) => { log.warn('email failed', { case: c.id, error: e.message }); result.emailError = e.message; }); result.email = step.email; }
    const next = this.campaign[c.step_index + 1];
    this.store.advance(c.id, c.step_index + 1, next ? scheduleAt(c.opened_at, next.day) : null);
    return result;
  }

  /** Called by the scheduler. Idempotent: only cases whose next_action_at has passed are touched. */
  async tick() {
    const due = this.store.dueCases(this.now().toISOString());
    const results = [];
    for (const c of due) {
      try { results.push({ case: c.id, ...(await this.runStep(c)) }); }
      catch (err) { log.error('step failed', { case: c.id, error: err.message }); this.store.advance(c.id, c.step_index, new Date(this.now().getTime() + 3600_000).toISOString()); }
    }
    return results;
  }
}
