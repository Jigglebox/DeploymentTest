const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => Number(env(k, d));

export const config = {
  port: num('PORT', 8787),
  dbPath: env('AGENTFUSE_DB', './data/agentfuse.db'),
  adminToken: env('AGENTFUSE_ADMIN_TOKEN', ''),
  publicUrl: env('AGENTFUSE_PUBLIC_URL', `http://localhost:${num('PORT', 8787)}`),
  alertWebhook: env('AGENTFUSE_ALERT_WEBHOOK', ''),
  alertEmail: env('AGENTFUSE_ALERT_EMAIL', ''),      // trip/burn-rate alerts by email (needs RESEND_API_KEY)
  resendApiKey: env('RESEND_API_KEY', ''),
  fromEmail: env('AGENTFUSE_FROM_EMAIL', 'alerts@example.com'),
  // Plan gating for the hosted/paid tiers. free=3 keys, pro=25, team=unlimited.
  plan: env('AGENTFUSE_PLAN', 'free'),
  // 'single': one tenant, admin token, provider keys from env.  'hosted': org signup/login, per-org provider keys sealed with the master key.
  mode: env('AGENTFUSE_MODE', 'single'),
  masterKey: env('AGENTFUSE_MASTER_KEY', ''),
  providers: {
    openai: { baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com'), apiKey: env('OPENAI_API_KEY', '') },
    anthropic: { baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'), apiKey: env('ANTHROPIC_API_KEY', '') },
  },
  billing: {
    secretKey: env('AGENTFUSE_STRIPE_SECRET_KEY', ''),
    webhookSecret: env('AGENTFUSE_STRIPE_WEBHOOK_SECRET', ''),
    proPriceId: env('AGENTFUSE_PRO_PRICE_ID', ''),
    teamPriceId: env('AGENTFUSE_TEAM_PRICE_ID', ''),
  },
  // Extend the per-provider route allow-list, e.g. [["POST","/v1/moderations","openai"]]
  extraRoutes: (() => { try { return JSON.parse(env('AGENTFUSE_EXTRA_ROUTES_JSON', '[]')); } catch { return []; } })(),
  ops: {
    githubToken: env('OPS_GITHUB_TOKEN', ''),
    githubRepo: env('OPS_GITHUB_REPO', ''),          // owner/repo that receives auto-error and feedback issues
    alertWebhook: env('OPS_ALERT_WEBHOOK', env('AGENTFUSE_ALERT_WEBHOOK', '')),
    digestIntervalSec: num('OPS_DIGEST_INTERVAL_SECONDS', 86400),
  },
  // Hosts a tenant may point a provider at (hosted mode). Wildcards allowed as a leading '*.'.
  allowedUpstreamHosts: env('AGENTFUSE_ALLOWED_UPSTREAM_HOSTS', 'api.openai.com,api.anthropic.com,*.openai.azure.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  pricingOverrides: env('AGENTFUSE_PRICING_JSON', ''),
  unknownModelPricePerM: { input: num('AGENTFUSE_UNKNOWN_INPUT_PRICE', 5), output: num('AGENTFUSE_UNKNOWN_OUTPUT_PRICE', 25) },
};

export const PLAN_LIMITS = { free: { maxKeys: 3 }, pro: { maxKeys: 25 }, team: { maxKeys: Infinity } };

/** Default policy applied to a new key when a field is omitted. */
export const DEFAULT_POLICY = {
  monthly_budget_usd: 50,
  daily_budget_usd: null,
  per_run_budget_usd: null,
  rpm_limit: 300,
  loop_window_sec: 120,
  loop_max_repeats: 8,
  burn_rate_alert_pct: 80,
  allowed_models: null,
};
