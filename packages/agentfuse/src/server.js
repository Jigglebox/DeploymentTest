#!/usr/bin/env node
import { Router, createApp } from '@jigglebox/shared/http';
import { log } from '@jigglebox/shared/log';
import { isMain } from '@jigglebox/shared/runtime';
import { config as defaultConfig } from './config.js';
import { Store } from './store.js';
import { createProxyHandler } from './proxy.js';
import { registerAdmin } from './admin.js';
import { registerBilling } from './billing.js';
import { createAuth } from './auth.js';
import { createOps } from '@jigglebox/shared/ops';
import { mailerFromEnv } from '@jigglebox/shared/mailer';
import { requireToken } from '@jigglebox/shared/http';
import { createLifecycle } from './lifecycle.js';
import { Stripe } from '@jigglebox/shared/stripe';

export function buildServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, providers: { ...defaultConfig.providers, ...(overrides.providers ?? {}) }, billing: { ...defaultConfig.billing, ...(overrides.billing ?? {}) }, ops: { ...defaultConfig.ops, ...(overrides.ops ?? {}) } };
  const store = new Store(config.dbPath);
  const router = new Router();
  const stripe = overrides.stripe ?? new Stripe(config.billing.secretKey);
  store.ensureDefaultOrg();
  const ops = createOps({ db: store.db, product: 'agentfuse', config: config.ops, fetchImpl: overrides.fetchImpl, now: overrides.now });
  const mailer = overrides.mailer ?? mailerFromEnv(config.resendApiKey, overrides.fetchImpl);
  const lifecycle = createLifecycle({ store, config, ops, mailer, now: overrides.now });
  const auth = createAuth({ store, config, onSignup: (org) => { ops.track('signup', { tenant: org.id }); lifecycle.welcome(org).catch(() => {}); } });
  auth.register(router);
  registerAdmin(router, { store, config, stripe, auth, ops });
  registerBilling(router, { store, config, stripe, auth, ops });
  ops.register(router, { auth: (req, url) => auth.requireOrg(req, url), navFor: () => [{ href: '/', label: 'Keys' }, { href: '/growth', label: 'Growth' }, { href: '/feedback', label: 'Feedback' }], mrrFn: () => store.mrr(),
    // In hosted mode growth numbers are the operator's, not a tenant's: require the admin token there.
    metricsAuth: config.mode === 'hosted' ? (req, url) => requireToken(req, config.adminToken || config.masterKey, url) : undefined });
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
