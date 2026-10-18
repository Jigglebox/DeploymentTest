// Email templates + pluggable sender. Templates are deliberately plain: they come from "billing",
// not "marketing", and plain-looking payment emails convert better than designed ones.
import { money } from '@jigglebox/shared/html';

const TEMPLATES = {
  payment_failed: {
    subject: ({ business }) => `Action needed: your ${business.name} payment didn't go through`,
    body: ({ business, amount, updateUrl, reason }) => `Hi,

We tried to charge ${amount} for your ${business.name} subscription, but the payment was declined${reason ? ` (${reason})` : ''}.

This usually means a card expired or a bank blocked the charge. You can fix it in under a minute here:

${updateUrl}

We'll automatically retry once your details are updated. Your access continues in the meantime.

Questions? Reply to this email or contact ${business.supportEmail}.

— ${business.name} billing`,
  },
  reminder: {
    subject: ({ business }) => `Reminder: update your payment method for ${business.name}`,
    body: ({ business, amount, updateUrl }) => `Hi,

Your ${business.name} payment of ${amount} is still outstanding. We'll try the charge again today; to make sure it goes through, update your card here:

${updateUrl}

— ${business.name} billing`,
  },
  reminder_urgent: {
    subject: ({ business }) => `Your ${business.name} subscription is at risk`,
    body: ({ business, amount, updateUrl }) => `Hi,

We still haven't been able to collect ${amount} for your ${business.name} subscription. To avoid losing access, please update your payment method:

${updateUrl}

If you've already updated your card, you can ignore this message.

— ${business.name} billing`,
  },
  final_notice: {
    subject: ({ business }) => `Final notice: ${business.name} subscription will be cancelled`,
    body: ({ business, amount, updateUrl }) => `Hi,

This is our last reminder. Your ${business.name} subscription will be cancelled in 7 days unless the outstanding ${amount} is paid. Update your card here to keep your account:

${updateUrl}

— ${business.name} billing`,
  },
  recovered: {
    subject: ({ business }) => `Thanks — your ${business.name} payment went through`,
    body: ({ business, amount }) => `Hi,

Good news: we successfully processed your ${amount} payment. Nothing else to do.

— ${business.name} billing`,
  },
};

export function renderEmail(template, ctx) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown email template ${template}`);
  const vars = { ...ctx, amount: money(ctx.amountCents) };
  return { subject: t.subject(vars), text: t.body(vars) };
}

export { consoleMailer, resendMailer } from '@jigglebox/shared/mailer';
