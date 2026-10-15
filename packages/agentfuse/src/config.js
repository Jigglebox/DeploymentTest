const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => Number(env(k, d));

export const config = {
  port: num('PORT', 8787),
  dbPath: env('AGENTFUSE_DB', './data/agentfuse.db'),
  adminToken: env('AGENTFUSE_ADMIN_TOKEN', ''),
  publicUrl: env('AGENTFUSE_PUBLIC_URL', `http://localhost:${num('PORT', 8787)}`),
  alertWebhook: env('AGENTFUSE_ALERT_WEBHOOK', ''),
  // Plan gating for the hosted/paid tiers. free=3 keys, pro=25, team=unlimited.
  plan: env('AGENTFUSE_PLAN', 'free'),
  providers: {
    openai: { baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com'), apiKey: env('OPENAI_API_KEY', '') },
    anthropic: { baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'), apiKey: env('ANTHROPIC_API_KEY', '') },
  },
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
