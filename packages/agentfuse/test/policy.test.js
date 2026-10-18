import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, postCheck } from '../src/policy.js';
import { priceFor, costUsd, estimateRequestCost } from '../src/pricing.js';
import { DEFAULT_POLICY } from '../src/config.js';

const key = (policy = {}, status = 'active') => ({ id: 'k', status, policy: { ...DEFAULT_POLICY, ...policy } });
const snap = (o = {}) => ({ monthUsd: 0, dayUsd: 0, hourUsd: 0, runUsd: 0, requestsLastMinute: 0, repeats: 0, ...o });

test('allows under budget', () => {
  assert.equal(decide({ key: key(), snapshot: snap(), estimateUsd: 0.01 }).allow, true);
});
test('blocks when monthly spend already at cap', () => {
  const d = decide({ key: key({ monthly_budget_usd: 10 }), snapshot: snap({ monthUsd: 10 }) });
  assert.equal(d.allow, false); assert.equal(d.reason, 'budget_exceeded'); assert.equal(d.trip, true);
});
test('pre-flight blocks a call that would cross the cap, without tripping', () => {
  const d = decide({ key: key({ monthly_budget_usd: 10 }), snapshot: snap({ monthUsd: 9.99 }), estimateUsd: 0.5 });
  assert.equal(d.allow, false); assert.equal(d.reason, 'budget_would_exceed'); assert.equal(d.trip, false);
});
test('per-run budget uses run spend', () => {
  const d = decide({ key: key({ per_run_budget_usd: 1 }), snapshot: snap({ runUsd: 1.2 }) });
  assert.equal(d.reason, 'budget_exceeded'); assert.equal(d.scope, 'run');
});
test('loop detection trips', () => {
  const d = decide({ key: key({ loop_max_repeats: 5 }), snapshot: snap({ repeats: 5 }) });
  assert.equal(d.reason, 'loop_detected'); assert.equal(d.trip, true);
});
test('rate limit does not trip', () => {
  const d = decide({ key: key({ rpm_limit: 10 }), snapshot: snap({ requestsLastMinute: 10 }) });
  assert.equal(d.reason, 'rate_limited'); assert.equal(d.trip, false);
});
test('tripped key stays blocked', () => {
  assert.equal(decide({ key: key({}, 'tripped'), snapshot: snap() }).reason, 'circuit_open');
});
test('model allow-list', () => {
  assert.equal(decide({ key: key({ allowed_models: ['gpt-4o-mini'] }), snapshot: snap(), model: 'gpt-4o' }).reason, 'model_not_allowed');
  assert.equal(decide({ key: key({ allowed_models: ['gpt-4o'] }), snapshot: snap(), model: 'gpt-4o-2024-08-06' }).allow, true);
});
test('threshold + burn-rate alerts', () => {
  const d = decide({ key: key({ monthly_budget_usd: 100 }), snapshot: snap({ monthUsd: 85, hourUsd: 5 }) });
  assert.equal(d.allow, true);
  assert.ok(d.alerts.some((a) => a.type === 'budget_threshold'));
  assert.ok(d.alerts.some((a) => a.type === 'burn_rate'));
});
test('postCheck trips once spend reaches cap', () => {
  assert.equal(postCheck({ key: key({ daily_budget_usd: 1 }), snapshot: snap({ dayUsd: 1 }) }).trip, true);
  assert.equal(postCheck({ key: key({ daily_budget_usd: 1 }), snapshot: snap({ dayUsd: 0.5 }) }).trip, false);
});
test('pricing prefix match and unknown fallback', () => {
  assert.equal(priceFor('gpt-4o-mini-2024-07-18').matched, 'gpt-4o-mini');
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('totally-new-model').known, false);
  assert.equal(costUsd('claude-sonnet-5-5', { input: 1_000_000, output: 100_000 }), 3);
  assert.equal(costUsd('gpt-4o', { input: 1000, cached: 1000, output: 0 }), (1000 * 2.5 + 1000 * 1.25) / 1e6);
});
test('pre-flight estimate scales with max_tokens', () => {
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x'.repeat(4000) }], max_tokens: 64000 };
  const expected = estimateRequestCost('claude-opus-5-5', body, 'expected');
  const strict = estimateRequestCost('claude-opus-5-5', body, 'strict');
  assert.ok(strict > expected);
  assert.ok(strict > 1.2 && strict < 1.3, `strict=${strict}`); // ~1000 in + 64k out @ $4/$20
});
