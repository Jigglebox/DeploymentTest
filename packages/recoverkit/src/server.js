#!/usr/bin/env node
import { Router, createApp, readBody, sendJson } from '@jigglebox/shared/http';
import { log } from '@jigglebox/shared/log';
import { isMain } from '@jigglebox/shared/runtime';
import { config as defaultConfig, DEFAULT_CAMPAIGN } from './config.js';
import { Store } from './store.js';
import { Stripe, verifyWebhook } from '@jigglebox/shared/stripe';
import { Engine } from './engine.js';
import { consoleMailer, resendMailer } from './emails.js';
import { registerAdmin } from './admin.js';

export function buildServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, business: { ...defaultConfig.business, ...(overrides.business ?? {}) } };
  const store = new Store(config.dbPath);
  const stripe = overrides.stripe ?? new Stripe(config.stripeSecretKey, { fetchImpl: overrides.fetchImpl ?? fetch, baseUrl: overrides.stripeBaseUrl });
  const mailer = overrides.mailer ?? (config.resendApiKey ? resendMailer(config.resendApiKey) : consoleMailer);
  const engine = new Engine({ store, stripe, mailer, config, campaign: overrides.campaign ?? DEFAULT_CAMPAIGN, now: overrides.now, fetchImpl: overrides.fetchImpl });
  const router = new Router();

  router.post('/webhooks/stripe', async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    let event;
    try { event = verifyWebhook(raw, req.headers['stripe-signature'], config.stripeWebhookSecret, { now: engine.now().getTime() }); }
    catch (err) { log.warn('webhook rejected', { error: err.message }); return sendJson(res, 400, { error: err.message }); }
    const result = await engine.handleEvent(event);
    sendJson(res, 200, { received: true, ...result });
  });
  registerAdmin(router, { store, engine, config });

  const server = createApp(router, { onError: (err) => log.error('unhandled', { error: err.message, stack: err.stack }) });
  let timer = null;
  const startScheduler = () => { timer = setInterval(() => engine.tick().catch((e) => log.error('tick failed', { error: e.message })), config.tickSeconds * 1000); timer.unref(); };
  const stop = () => { if (timer) clearInterval(timer); server.close(); };
  return { server, store, engine, config, startScheduler, stop };
}

if (isMain(import.meta.url)) {
  const app = buildServer();
  app.startScheduler();
  app.server.listen(app.config.port, () => log.info('recoverkit listening', { port: app.config.port, mailer: app.engine.mailer.name, stripe: Boolean(app.config.stripeSecretKey) }));
}
