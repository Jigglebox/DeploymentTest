import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { config, DEFAULT_CAMPAIGN } from '../src/config.js';
import { fakeStripe, failedInvoiceEvent } from './fake-stripe.js';

function setup({ campaign = DEFAULT_CAMPAIGN } = {}) {
  const store = new Store(':memory:');
  const stripe = fakeStripe();
  const mailer = { name: 'test', sent: [], async send(m) { this.sent.push(m); return { id: 'm' + this.sent.length }; } };
  const clock = { t: Date.parse('2026-10-01T15:00:00Z') };
  const engine = new Engine({ store, stripe, mailer, config: { ...config, alertWebhook: '' }, campaign, now: () => new Date(clock.t) });
  const advanceDays = (d) => { clock.t += d * 86_400_000; };
  return { store, stripe, mailer, engine, clock, advanceDays };
}

test('failed invoice opens a case and day-0 email goes out with a card-update link', async () => {
  const { store, stripe, mailer, engine } = setup();
  stripe.seed('in_1', { amount_due: 4900 });
  const r = await engine.handleEvent(failedInvoiceEvent());
  assert.equal(r.created, true);
  const c = store.caseByInvoice('in_1');
  assert.equal(c.status, 'open'); assert.equal(c.amount_cents, 4900); assert.equal(c.failure_code, 'insufficient_funds'); assert.equal(c.hard_decline, 0);
  const ran = await engine.tick();
  assert.equal(ran.length, 1);
  assert.equal(mailer.sent.length, 1);
  assert.match(mailer.sent[0].subject, /didn't go through/);
  assert.ok(mailer.sent[0].text.includes('https://billing.stripe.com/session/cus_1'));
  assert.equal(store.getCase(c.id).step_index, 1);
  assert.equal(await engine.tick().then((x) => x.length), 0, 'nothing due until day 3');
});

test('duplicate webhook deliveries are ignored', async () => {
  const { engine } = setup();
  const ev = failedInvoiceEvent();
  await engine.handleEvent(ev);
  assert.deepEqual(await engine.handleEvent(ev), { duplicate: true });
});

test('campaign retries on schedule and recovers when the card works', async () => {
  const { store, stripe, mailer, engine, advanceDays } = setup();
  stripe.seed('in_1', {});
  await engine.handleEvent(failedInvoiceEvent());
  await engine.tick();                       // day 0 email
  advanceDays(3);
  await engine.tick();                       // day 3: retry fails (default outcome), reminder sent
  const c1 = store.caseByInvoice('in_1');
  assert.equal(c1.attempts, 2); assert.equal(c1.step_index, 2);
  assert.equal(stripe.calls.filter((x) => x.method === 'payInvoice').length, 1);
  advanceDays(4);
  stripe.outcomes.set('in_1', 'paid');
  await engine.tick();                       // day 7: retry succeeds
  const c2 = store.caseByInvoice('in_1');
  assert.equal(c2.status, 'recovered'); assert.equal(c2.recovered_by, 'retry:step2');
  assert.match(mailer.sent.at(-1).subject, /Thanks/);
  assert.equal(await engine.tick().then((x) => x.length), 0, 'recovered case is no longer scheduled');
  const s = store.stats(new Date(Date.parse('2026-10-20T00:00:00Z')));
  assert.equal(s.recovered_cents, 4900); assert.equal(s.recovery_rate, 1);
});

test('hard declines skip retries until the customer updates their card, then retry immediately', async () => {
  const { store, stripe, engine, advanceDays } = setup();
  stripe.seed('in_1', {});
  await engine.handleEvent(failedInvoiceEvent({ last_payment_error: { code: 'card_declined', decline_code: 'expired_card', message: 'Your card has expired.' } }));
  const c = store.caseByInvoice('in_1');
  assert.equal(c.hard_decline, 1);
  await engine.tick(); advanceDays(3); await engine.tick();
  assert.equal(stripe.calls.filter((x) => x.method === 'payInvoice').length, 0, 'no pointless retries on an expired card');
  assert.ok(store.actionsFor(c.id).some((a) => a.type === 'retry_skipped'));
  stripe.outcomes.set('in_1', 'paid');
  const r = await engine.handleEvent({ id: 'evt_pm', type: 'payment_method.attached', data: { object: { object: 'payment_method', customer: 'cus_1' } } });
  assert.equal(r.retried[0].paid, true);
  assert.equal(store.getCase(c.id).status, 'recovered');
  assert.equal(store.getCase(c.id).recovered_by, 'retry:card_updated');
});

test('invoice.paid from Stripe (e.g. Stripe Smart Retries) closes the case as recovered', async () => {
  const { store, engine } = setup();
  await engine.handleEvent(failedInvoiceEvent());
  await engine.handleEvent({ id: 'evt_paid', type: 'invoice.paid', data: { object: { id: 'in_1', paid: true } } });
  assert.equal(store.caseByInvoice('in_1').status, 'recovered');
});

test('subscription cancelled closes open cases as lost; campaign end closes as lost', async () => {
  const { store, engine, advanceDays } = setup();
  await engine.handleEvent(failedInvoiceEvent());
  await engine.handleEvent({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
  assert.equal(store.caseByInvoice('in_1').status, 'lost');

  const b = setup(); b.stripe.seed('in_1', {});
  await b.engine.handleEvent(failedInvoiceEvent());
  for (const d of [0, 3, 4, 7, 7]) { b.advanceDays(d); await b.engine.tick(); }
  assert.equal(b.store.caseByInvoice('in_1').status, 'lost');
  assert.equal(b.mailer.sent.length, 4, 'four campaign emails');
});

test('a repeat failure on the same invoice updates the open case instead of duplicating', async () => {
  const { store, engine } = setup();
  await engine.handleEvent(failedInvoiceEvent());
  const r = await engine.handleEvent(failedInvoiceEvent({ attempt_count: 2, last_payment_error: { code: 'card_declined', decline_code: 'lost_card', message: 'lost' } }));
  assert.equal(r.updated, true);
  const c = store.caseByInvoice('in_1');
  assert.equal(c.attempts, 2); assert.equal(c.hard_decline, 1); assert.equal(store.listCases().length, 1);
});
