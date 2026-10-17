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
import { registerConnect } from './connect.js';
import { FeeBilling } from './fees.js';
import { createOps } from '@jigglebox/shared/ops';
import { requireToken } from '@jigglebox/shared/http';

export function buildServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, business: { ...defaultConfig.business, ...(overrides.business ?? {}) }, ops: { ...defaultConfig.ops, ...(overrides.ops ?? {}) } };
  const store = new Store(config.dbPath);
  const stripe = overrides.stripe ?? new Stripe(config.stripeSecretKey, { fetchImpl: overrides.fetchImpl ?? fetch, baseUrl: overrides.stripeBaseUrl });
  const mailer = overrides.mailer ?? (config.resendApiKey ? resendMailer(config.resendApiKey) : consoleMailer);
  const fees = new FeeBilling({ store, stripe, config, now: overrides.now ?? (() => new Date()) });
  const engine = new Engine({ store, stripe, mailer, config, campaign: overrides.campaign ?? DEFAULT_CAMPAIGN, now: overrides.now, fetchImpl: overrides.fetchImpl, fees });
  const router = new Router();

  router.post('/webhooks/stripe', async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    // One endpoint serves both the account webhook (single-tenant) and the Connect webhook (hosted); each has its own secret.
    let event, lastErr;
    for (const secret of [config.stripeWebhookSecret, config.stripeConnectWebhookSecret].filter(Boolean)) {
      try { event = verifyWebhook(raw, req.headers['stripe-signature'], secret, { now: engine.now().getTime() }); break; }
      catch (err) { lastErr = err; }
    }
    if (!event) { log.warn('webhook rejected', { error: lastErr?.message ?? 'no webhook secret configured' }); return sendJson(res, 400, { error: lastErr?.message ?? 'no webhook secret configured' }); }
    const result = await engine.handleEvent(event);
    sendJson(res, 200, { received: true, ...result });
  });
  registerAdmin(router, { store, engine, config, fees });
  registerConnect(router, { store, stripe, config });
  const ops = createOps({ db: store.db, product: 'recoverkit', config: config.ops, fetchImpl: overrides.fetchImpl, now: overrides.now });
  ops.register(router, { auth: (req, url) => { requireToken(req, config.adminToken, url); return { id: 'self', email: config.business.supportEmail }; }, navFor: (url) => [{ href: '/' + (config.adminToken ? `?token=${encodeURIComponent(url.searchParams.get('token') ?? '')}` : ''), label: 'Cases' }, { href: '/feedback' + url.search, label: 'Feedback' }] });

  const server = createApp(router, { onError: (err, ctx) => { ops.capture(err, ctx); log.error('unhandled', { error: err.message, stack: err.stack, ...ctx }); } });
  let timer = null;
  const startScheduler = () => { ops.attachProcess(); timer = setInterval(() => engine.tick().then(() => fees.tick()).then(() => ops.tick()).catch((e) => log.error('tick failed', { error: e.message })), config.tickSeconds * 1000); timer.unref(); };
  const stop = () => { if (timer) clearInterval(timer); server.close(); };
  return { server, store, engine, fees, ops, config, startScheduler, stop };
}

if (isMain(import.meta.url)) {
  const app = buildServer();
  app.startScheduler();
  app.server.listen(app.config.port, () => log.info('recoverkit listening', { port: app.config.port, mailer: app.engine.mailer.name, stripe: Boolean(app.config.stripeSecretKey) }));
}
