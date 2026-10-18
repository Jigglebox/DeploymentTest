#!/usr/bin/env node
import { Router, createApp } from '@jigglebox/shared/http';
import { log } from '@jigglebox/shared/log';
import { isMain } from '@jigglebox/shared/runtime';
import { config as defaultConfig } from './config.js';
import { Store } from './store.js';
import { createProxyHandler } from './proxy.js';
import { registerAdmin } from './admin.js';
import { createTenancy } from '@jigglebox/shared/tenancy';
import { createSubscriptions } from '@jigglebox/shared/subscriptions';
import { createOps } from '@jigglebox/shared/ops';
import { mailerFromEnv } from '@jigglebox/shared/mailer';
import { createLifecycle } from './lifecycle.js';
import { Stripe } from '@jigglebox/shared/stripe';

export function buildServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, providers: { ...defaultConfig.providers, ...(overrides.providers ?? {}) }, billing: { ...defaultConfig.billing, ...(overrides.billing ?? {}) }, ops: { ...defaultConfig.ops, ...(overrides.ops ?? {}) } };
  const store = new Store(config.dbPath);
  const router = new Router();
  const stripe = overrides.stripe ?? new Stripe(config.billing.secretKey);
  const ops = createOps({ db: store.db, product: 'agentfuse', config: config.ops, fetchImpl: overrides.fetchImpl, now: overrides.now });
  const mailer = overrides.mailer ?? mailerFromEnv(config.resendApiKey, overrides.fetchImpl);
  const lifecycle = createLifecycle({ store, config, ops, mailer, now: overrides.now });
  if (config.mode === 'hosted' && !config.masterKey) throw new Error('AGENTFUSE_MODE=hosted requires AGENTFUSE_MASTER_KEY (32 bytes hex)');
  const auth = createTenancy({ db: store.db, product: 'AgentFuse', mode: config.mode, adminToken: config.adminToken, sessionSecret: config.masterKey, publicUrl: config.publicUrl, defaultPlan: config.plan, tokenPrefix: 'af_org_',
    onSignup: (org) => { ops.track('signup', { tenant: org.id }); lifecycle.welcome(org).catch(() => {}); } });
  store.tenancy = auth;
  store.ensureDefaultOrg();
  auth.register(router);
  const billing = createSubscriptions({ product: 'agentfuse', tenancy: auth, stripe, ops, config: { secretKey: config.billing.secretKey, webhookSecret: config.billing.webhookSecret, publicUrl: config.publicUrl, prices: { pro: config.billing.proPriceId, team: config.billing.teamPriceId } } });
  billing.register(router);
  registerAdmin(router, { store, config, stripe, auth, ops, billing });
  ops.register(router, { auth: (req, url) => auth.requireOrg(req, url), navFor: () => [{ href: '/', label: 'Keys' }, { href: '/growth', label: 'Growth' }, { href: '/feedback', label: 'Feedback' }], mrrFn: () => store.mrr(),
    // In hosted mode growth numbers are the operator's, not a tenant's: require the admin token there.
    metricsAuth: (req, url) => auth.requireOperator(req, url), opsAuth: (req, url) => auth.requireOperator(req, url) });
  const proxy = createProxyHandler({ store, config, fetchImpl: overrides.fetchImpl, mailer, ops });
  router.any('/openai/*', proxy);
  router.any('/anthropic/*', proxy);
  const server = createApp(router, { onError: (err, ctx) => { ops.capture(err, ctx); log.error('unhandled', { error: err.message, stack: err.stack, ...ctx }); } });
  let timer = null;
  const startScheduler = () => { ops.attachProcess(); timer = setInterval(() => ops.tick().then(() => lifecycle.tick()).catch((e) => log.error('ops tick failed', { error: e.message })), 3600 * 1000); timer.unref(); };
  return { server, store, config, ops, lifecycle, startScheduler };
}

if (isMain(import.meta.url)) {
  const { server, config, startScheduler } = buildServer();
  startScheduler();
  server.listen(config.port, () => log.info('agentfuse listening', { port: config.port, mode: config.mode, plan: config.plan, admin_auth: Boolean(config.adminToken), openai: Boolean(config.providers.openai.apiKey), anthropic: Boolean(config.providers.anthropic.apiKey) }));
}
