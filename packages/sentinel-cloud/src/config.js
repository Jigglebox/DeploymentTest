const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => Number(env(k, d));
export const config = {
  port: num('PORT', 8789),
  dbPath: env('SENTINEL_DB', './data/sentinel-cloud.db'),
  adminToken: env('SENTINEL_ADMIN_TOKEN', ''),
  publicUrl: env('SENTINEL_PUBLIC_URL', `http://localhost:${num('PORT', 8789)}`),
  plan: env('SENTINEL_PLAN', 'free'),
  mode: env('SENTINEL_MODE', 'single'),               // 'hosted': org signup/login, org-scoped projects, per-seat billing
  sessionSecret: env('SENTINEL_SESSION_SECRET', ''),
  billing: { secretKey: env('SENTINEL_STRIPE_SECRET_KEY', ''), webhookSecret: env('SENTINEL_STRIPE_WEBHOOK_SECRET', ''), proPriceId: env('SENTINEL_PRO_PRICE_ID', '') },
  seatPriceCents: num('SENTINEL_SEAT_PRICE_CENTS', 1900),
  scanIntervalSec: num('SENTINEL_SCAN_INTERVAL_SECONDS', 3600),
  scanTimeoutMs: num('SENTINEL_SCAN_TIMEOUT_MS', 15000),
  ops: {
    githubToken: env('OPS_GITHUB_TOKEN', ''),
    githubRepo: env('OPS_GITHUB_REPO', ''),          // owner/repo that receives auto-error and feedback issues
    alertWebhook: env('OPS_ALERT_WEBHOOK', env('SENTINEL_ALERT_WEBHOOK', '')),
    digestIntervalSec: num('OPS_DIGEST_INTERVAL_SECONDS', 86400),
  },

};
export const PLAN_LIMITS = { free: { maxProjects: 1 }, pro: { maxProjects: Infinity }, team: { maxProjects: Infinity } };
