import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { fakeUpstream, listen } from './helpers.js';

let up, app, base, store;
const alerts = [];
const alertFetch = async (url, init) => { alerts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };

before(async () => {
  up = await fakeUpstream();
  app = buildServer({ dbPath: ':memory:', adminToken: 'admin', plan: 'team', extraRoutes: [['POST', '/v1/audio/speech', 'openai']], alertWebhook: 'http://alerts.local/hook', publicUrl: 'http://af.local',
    providers: { openai: { baseUrl: up.url, apiKey: 'sk-real' }, anthropic: { baseUrl: up.url, apiKey: 'ant-real' } },
    fetchImpl: (url, init) => (String(url).startsWith('http://alerts.local') ? alertFetch(url, init) : fetch(url, init)) });
  store = app.store;
  base = await listen(app.server);
});
after(() => { app.server.close(); up.server.close(); });

const admin = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: 'Bearer admin', 'content-type': 'application/json', ...(init.headers ?? {}) } }).then(async (r) => ({ status: r.status, json: await r.json() }));
const chat = (rawKey, body, headers = {}) => fetch(base + '/openai/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('admin auth is enforced', async () => {
  const r = await fetch(base + '/api/keys');
  assert.equal(r.status, 401);
});

test('end-to-end: meter, pre-flight block, trip, resume', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'agent-a', policy: { monthly_budget_usd: 0.02, loop_max_repeats: 50 } }) });
  assert.equal(created.status, 201);
  const raw = created.json.raw_key;
  assert.match(raw, /^af_live_/);

  // 1000 in + 100 out on gpt-4o-mini = 0.15*1000/1e6 + 0.6*100/1e6 = $0.00021
  const r1 = await chat(raw, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('x-agentfuse-cost-usd'), '0.000210');
  assert.equal(up.calls.at(-1).headers.authorization, 'Bearer sk-real', 'real key swapped in');
  assert.equal(up.calls.at(-1).headers['x-agentfuse-run'], undefined);

  // A huge request is blocked BEFORE it reaches the provider (pre-flight).
  const callsBefore = up.calls.length;
  const r2 = await chat(raw, { model: 'gpt-4o', messages: [{ role: 'user', content: 'x'.repeat(40000) }], max_tokens: 4000 });
  assert.equal(r2.status, 402);
  const e2 = await r2.json();
  assert.equal(e2.error.code, 'budget_would_exceed');
  assert.equal(up.calls.length, callsBefore, 'provider never called');
  assert.equal(store.getKey(created.json.key.id).status, 'active', 'pre-flight block does not trip');

  // Spend past the cap -> breaker opens -> subsequent calls blocked even if tiny.
  const r3 = await chat(raw, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 40000 }); // 0.6*40000/1e6 = $0.024
  assert.equal(r3.status, 200);
  assert.equal(r3.headers.get('x-agentfuse-tripped'), 'budget_exceeded');
  const r4 = await chat(raw, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'tiny' }], max_tokens: 1 });
  assert.equal(r4.status, 402);
  assert.equal((await r4.json()).error.code, 'circuit_open');
  assert.ok(alerts.some((a) => a.type === 'tripped'), 'webhook fired');

  // Resume via admin API, raise budget, call succeeds again.
  await admin(`/api/keys/${created.json.key.id}/policy`, { method: 'PUT', body: JSON.stringify({ monthly_budget_usd: 100 }) });
  const resumed = await admin(`/api/keys/${created.json.key.id}/resume`, { method: 'POST' });
  assert.equal(resumed.json.key.status, 'active');
  const r5 = await chat(raw, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'back' }], max_tokens: 10 });
  assert.equal(r5.status, 200);
});

test('loop detection trips the breaker on identical repeated requests', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'looper', policy: { loop_max_repeats: 3, monthly_budget_usd: 1000 } }) });
  const raw = created.json.raw_key;
  const body = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'same' }], max_tokens: 5 };
  for (let i = 0; i < 3; i++) assert.equal((await chat(raw, body)).status, 200);
  const r = await chat(raw, body);
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error.code, 'loop_detected');
  assert.equal(store.getKey(created.json.key.id).tripped_reason, 'loop_detected');
});

test('per-run budget via X-AgentFuse-Run header', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'runner', policy: { per_run_budget_usd: 0.001, monthly_budget_usd: 1000, loop_max_repeats: 100 } }) });
  const raw = created.json.raw_key;
  const body = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'r' }], max_tokens: 1000 }; // ~$0.00075 each
  assert.equal((await chat(raw, body, { 'x-agentfuse-run': 'run-1' })).status, 200);
  const blocked = await chat(raw, { ...body, messages: [{ role: 'user', content: 'r2' }] }, { 'x-agentfuse-run': 'run-1' });
  assert.equal(blocked.status, 402);
  assert.equal((await blocked.json()).error.scope, 'run');
  assert.equal((await chat(raw, body, { 'x-agentfuse-run': 'run-2' })).status, 200, 'a fresh run is unaffected');
});

test('streaming passes through and is metered (OpenAI + Anthropic)', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'streamer', policy: { monthly_budget_usd: 1000, loop_max_repeats: 100 } }) });
  const raw = created.json.raw_key;
  const r = await chat(raw, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 's' }], max_tokens: 100, stream: true });
  assert.equal(r.headers.get('content-type'), 'text/event-stream', await r.clone().text());
  const text = await r.text();
  assert.ok(text.includes('[DONE]'));
  assert.equal(up.calls.at(-1).body.stream_options?.include_usage, true, 'usage chunk requested from upstream');

  const a = await fetch(base + '/anthropic/v1/messages', { method: 'POST', headers: { 'x-api-key': raw, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 500, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(a.status, 200);
  await a.text();
  assert.equal(up.calls.at(-1).headers['x-api-key'], 'ant-real');

  const detail = await admin(`/api/keys/${created.json.key.id}`);
  const [anth, oai] = detail.json.recent;
  assert.equal(oai.input_tokens, 1000); assert.equal(oai.output_tokens, 100);
  assert.equal(anth.input_tokens, 2000); assert.equal(anth.output_tokens, 500);
  assert.equal(anth.cost_usd, (2000 * 2 + 500 * 10) / 1e6);
});

test('binary upstream bodies pass through byte-for-byte', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'tts', policy: { monthly_budget_usd: 1000 } }) });
  const r = await fetch(base + '/openai/v1/audio/speech', { method: 'POST', headers: { authorization: `Bearer ${created.json.raw_key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: 'hi' }) });
  assert.equal(r.status, 200);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0xff, 0xfb, 0x90, 0x00, 0xfe]);
});

test('OpenAI cached prompt tokens are billed once at the cached rate', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'cached', policy: { monthly_budget_usd: 1000 } }) });
  const r = await chat(created.json.raw_key, { model: 'gpt-4o-cached', messages: [{ role: 'user', content: 'c' }] });
  assert.equal(r.headers.get('x-agentfuse-cost-usd'), '0.001250'); // 1000 cached @ $1.25/M, nothing at $2.50/M
});

test('virtual keys cannot reach non-inference provider routes', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'scoped', policy: { monthly_budget_usd: 1000 } }) });
  const h = { authorization: `Bearer ${created.json.raw_key}`, 'content-type': 'application/json' };
  const before = up.calls.length;
  for (const [method, path] of [['GET', '/openai/v1/files'], ['DELETE', '/openai/v1/files/file-1'], ['POST', '/openai/v1/fine_tuning/jobs'], ['POST', '/openai/v1/batches'], ['POST', '/anthropic/v1/messages/batches'], ['DELETE', '/anthropic/v1/files/f1']]) {
    const r = await fetch(base + path, { method, headers: h, body: method === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal((await r.json()).error.code, 'route_not_allowed');
  }
  assert.equal(up.calls.length, before, 'nothing reached the provider');
  assert.equal((await fetch(base + '/openai/v1/chat/completions', { method: 'POST', headers: { ...h, 'content-type': 'text/plain' }, body: 'not json' })).status, 400);
});

test('client cannot opt out of streaming usage; missing usage is billed at worst case', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'sneaky', policy: { monthly_budget_usd: 1000 } }) });
  const raw = created.json.raw_key;
  const r = await chat(raw, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 's' }], max_tokens: 100, stream: true, stream_options: { include_usage: false } });
  await r.text();
  assert.equal(up.calls.at(-1).body.stream_options.include_usage, true, 'include_usage forced on');
  const r2 = await chat(raw, { model: 'gpt-4o-nousage', messages: [{ role: 'user', content: 'x'.repeat(400) }], max_tokens: 40000 });
  assert.equal(r2.status, 200);
  // strict estimate: ~100 prompt tokens @ $2.5/M + 40000 output @ $10/M ≈ $0.4003 (gpt-4o price via prefix)
  assert.ok(Number(r2.headers.get('x-agentfuse-cost-usd')) > 0.39, r2.headers.get('x-agentfuse-cost-usd'));
});

test('allowed_models denies requests that name no model', async () => {
  const created = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'strict-models', policy: { allowed_models: ['gpt-4o-mini'] } }) });
  const r = await chat(created.json.raw_key, { messages: [{ role: 'user', content: 'no model' }] });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'model_not_allowed');
});

test('plan limit gates key creation', async () => {
  const limited = buildServer({ dbPath: ':memory:', plan: 'free' });
  const b = await listen(limited.server);
  const mk = (n) => fetch(b + '/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'k' + n }) });
  for (let i = 0; i < 3; i++) assert.equal((await mk(i)).status, 201);
  assert.equal((await mk(9)).status, 402);
  limited.server.close();
});

test('dashboard renders', async () => {
  const r = await fetch(base + '/?token=admin');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('AgentFuse') && html.includes('looper'));
});

test('CSV audit export is org-scoped and well-formed', async () => {
  const r = await fetch(base + '/api/export.csv', { headers: { authorization: 'Bearer admin' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const lines = (await r.text()).trim().split('\n');
  assert.equal(lines[0], 'created_at,key_name,key_id,run_id,provider,model,input_tokens,output_tokens,cost_usd,estimated,status,latency_ms');
  assert.ok(lines.length > 5, 'rows from earlier tests are included');
  assert.ok(lines.some((l) => l.includes('agent-a')));
});

test('a trip also sends an email alert when a mailer and recipient are configured', async (t) => {
  const mailer = { name: 'test', sent: [], async send(m) { this.sent.push(m); return {}; } };
  const local = buildServer({ dbPath: ':memory:', plan: 'team', alertEmail: 'oncall@example.com', mailer, providers: { openai: { baseUrl: up.url, apiKey: 'k' }, anthropic: { baseUrl: up.url, apiKey: 'k' } } });
  const b = await listen(local.server);
  t.after(() => { local.server.closeAllConnections(); local.server.close(); });
  const k = local.store.createKey({ name: 'mailtest', policy: { monthly_budget_usd: 0.0001 } }); // pre-flight (~$0.00006) passes, actual ($0.00021) crosses
  const r = await fetch(b + '/openai/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${k.raw_key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 }) });
  assert.equal(r.headers.get('x-agentfuse-tripped'), 'budget_exceeded');
  assert.equal(mailer.sent.length, 1); assert.equal(mailer.sent[0].to, 'oncall@example.com'); assert.match(mailer.sent[0].subject, /mailtest tripped/);
});
