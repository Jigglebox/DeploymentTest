const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => Number(env(k, d));
export const config = {
  port: num('PORT', 8789),
  dbPath: env('SENTINEL_DB', './data/sentinel-cloud.db'),
  adminToken: env('SENTINEL_ADMIN_TOKEN', ''),
  publicUrl: env('SENTINEL_PUBLIC_URL', `http://localhost:${num('PORT', 8789)}`),
  plan: env('SENTINEL_PLAN', 'free'),
  scanIntervalSec: num('SENTINEL_SCAN_INTERVAL_SECONDS', 3600),
  scanTimeoutMs: num('SENTINEL_SCAN_TIMEOUT_MS', 15000),
};
export const PLAN_LIMITS = { free: { maxProjects: 1 }, pro: { maxProjects: Infinity }, team: { maxProjects: Infinity } };
