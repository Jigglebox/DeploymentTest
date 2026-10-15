const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => Number(env(k, d));

export const config = {
  port: num('PORT', 8788),
  dbPath: env('RECOVERKIT_DB', './data/recoverkit.db'),
  adminToken: env('RECOVERKIT_ADMIN_TOKEN', ''),
  publicUrl: env('RECOVERKIT_PUBLIC_URL', `http://localhost:${num('PORT', 8788)}`),
  stripeSecretKey: env('STRIPE_SECRET_KEY', ''),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
  // Hosted / multi-merchant mode (Stripe Connect Standard): platform client id + Connect webhook endpoint secret.
  stripeClientId: env('STRIPE_CLIENT_ID', ''),
  stripeConnectWebhookSecret: env('STRIPE_CONNECT_WEBHOOK_SECRET', ''),
  business: {
    name: env('RECOVERKIT_BUSINESS_NAME', 'Your Company'),
    supportEmail: env('RECOVERKIT_SUPPORT_EMAIL', 'support@example.com'),
    fromEmail: env('RECOVERKIT_FROM_EMAIL', 'billing@example.com'),
    returnUrl: env('RECOVERKIT_RETURN_URL', 'https://example.com/account'),
  },
  resendApiKey: env('RESEND_API_KEY', ''),
  feePct: num('RECOVERKIT_FEE_PCT', 20),          // performance pricing: % of recovered revenue
  tickSeconds: num('RECOVERKIT_TICK_SECONDS', 300),
  alertWebhook: env('RECOVERKIT_ALERT_WEBHOOK', ''),
};

/**
 * The recovery campaign. `day` = days after the first failure. Each step may send an email
 * template and/or retry the charge. Hard declines (lost/stolen/expired card) skip retries.
 */
export const DEFAULT_CAMPAIGN = [
  { day: 0, email: 'payment_failed', retry: false },
  { day: 3, email: 'reminder', retry: true },
  { day: 7, email: 'reminder_urgent', retry: true },
  { day: 14, email: 'final_notice', retry: true },
  { day: 21, close: 'lost' },
];

/** Decline codes where retrying the same card is pointless (and hurts your processor standing). */
export const HARD_DECLINES = new Set(['lost_card', 'stolen_card', 'pickup_card', 'expired_card', 'incorrect_number', 'invalid_account', 'card_not_supported', 'do_not_honor', 'fraudulent', 'restricted_card', 'revocation_of_all_authorizations', 'revocation_of_authorization', 'stop_payment_order']);
