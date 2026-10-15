#!/usr/bin/env node
import { Router, createApp } from '@jigglebox/shared/http';
import { log } from '@jigglebox/shared/log';
import { isMain } from '@jigglebox/shared/runtime';
import { config as defaultConfig } from './config.js';
import { Store } from './store.js';
import { createProxyHandler } from './proxy.js';
import { registerAdmin } from './admin.js';
import { registerBilling } from './billing.js';
import { Stripe } from '@jigglebox/shared/stripe';

export function buildServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, providers: { ...defaultConfig.providers, ...(overrides.providers ?? {}) }, billing: { ...defaultConfig.billing, ...(overrides.billing ?? {}) } };
  const store = new Store(config.dbPath);
  const router = new Router();
  const stripe = overrides.stripe ?? new Stripe(config.billing.secretKey);
  registerAdmin(router, { store, config, stripe });
  registerBilling(router, { store, config, stripe });
  const proxy = createProxyHandler({ store, config, fetchImpl: overrides.fetchImpl });
  router.any('/openai/*', proxy);
  router.any('/anthropic/*', proxy);
  const server = createApp(router, { onError: (err) => log.error('unhandled', { error: err.message, stack: err.stack }) });
  return { server, store, config };
}

if (isMain(import.meta.url)) {
  const { server, config } = buildServer();
  server.listen(config.port, () => log.info('agentfuse listening', { port: config.port, plan: config.plan, admin_auth: Boolean(config.adminToken), openai: Boolean(config.providers.openai.apiKey), anthropic: Boolean(config.providers.anthropic.apiKey) }));
}
