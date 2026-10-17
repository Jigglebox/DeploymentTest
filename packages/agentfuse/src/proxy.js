// The enforcement path. Every provider call flows through here:
// authenticate virtual key -> estimate -> decide -> forward -> meter -> post-check (trip breaker).
import { readBody, sendJson } from '@jigglebox/shared/http';
import { postWebhook } from '@jigglebox/shared/notify';
import { log } from '@jigglebox/shared/log';
import { resolveProvider, extractClientKey, routeAllowed } from './providers.js';
import { decide, postCheck } from './policy.js';
import { costUsd, estimateRequestCost } from './pricing.js';
import { fingerprintBody } from './store.js';
import { unseal } from '@jigglebox/shared/crypto';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'content-encoding', 'accept-encoding']);
const STATUS_FOR = { circuit_open: 402, budget_exceeded: 402, budget_would_exceed: 402, loop_detected: 402, key_disabled: 403, model_not_allowed: 403, rate_limited: 429 };

function errorBody(decision, key, publicUrl) {
  const message = `AgentFuse blocked this request: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ''}. Resume at ${publicUrl}/keys/${key.id}`;
  // Shape satisfies both OpenAI and Anthropic SDK error parsers.
  return { type: 'error', error: { type: 'agentfuse_' + decision.reason, code: decision.reason, message, key_id: key.id, scope: decision.scope, limit: decision.limit, spent: decision.spent } };
}

export function createProxyHandler({ store, config, fetchImpl = fetch, mailer = null, ops = null }) {
  const alertOnce = async (key, type, payload, cooldownSec = 3600) => {
    const last = store.lastEventAt(key.id, type);
    if (last && Date.now() - Date.parse(last) < cooldownSec * 1000) return;
    store.event(key.id, type, payload);
    await postWebhook(config.alertWebhook, { text: `AgentFuse ${type} for key "${key.name}": ${JSON.stringify(payload)}`, type, key: { id: key.id, name: key.name }, ...payload }, { fetchImpl });
  };
  const email = async (key, subject, text) => {
    const to = store.getOrg(key.org_id)?.email || config.alertEmail;
    if (!mailer || !to) return;
    await mailer.send({ from: config.fromEmail, to, subject, text }).catch((e) => log.warn('alert email failed', { error: e.message }));
  };
  const trip = async (key, reason, detail) => {
    store.trip(key.id, reason, detail);
    ops?.track('tripped', { tenant: key.org_id, props: { reason } });
    const text = `AgentFuse TRIPPED key "${key.name}": ${reason} ${JSON.stringify(detail)}. Resume: ${config.publicUrl}/keys/${key.id}`;
    await postWebhook(config.alertWebhook, { text, type: 'tripped', key: { id: key.id, name: key.name }, reason, ...detail }, { fetchImpl });
    await email(key, `[AgentFuse] ${key.name} tripped: ${reason}`, text);
  };

  /** hosted: the org's own sealed credentials. single: the environment. */
  const resolveUpstream = (orgId, providerName) => {
    if (config.mode !== 'hosted') return config.providers[providerName];
    const own = store.providersFor(orgId).find((p) => p.provider === providerName);
    if (!own) return null;
    try { return { apiKey: unseal(own.api_key_sealed, config.masterKey), baseUrl: own.base_url || config.providers[providerName].baseUrl }; }
    catch (err) { log.error('cannot unseal provider key', { org: orgId, provider: providerName, error: err.message }); return null; }
  };

  return async function handleProxy(req, res, { url }) {
    const resolved = resolveProvider(url.pathname);
    if (!resolved) return sendJson(res, 404, { error: { message: 'unknown provider path; use /openai/v1/... or /anthropic/v1/...' } });
    const { provider, upstreamPath } = resolved;
    if (!routeAllowed(provider, req.method, upstreamPath, config.extraRoutes ?? [])) {
      return sendJson(res, 403, { type: 'error', error: { type: 'agentfuse_route_not_allowed', code: 'route_not_allowed', message: `AgentFuse only proxies inference routes (${provider.routes.map((r) => r.join(' ')).join(', ')}); ${req.method} ${upstreamPath} is not forwarded` } });
    }

    const rawKey = extractClientKey(req.headers);
    const key = rawKey ? store.findKeyByRaw(rawKey) : null;
    if (!key) return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid AgentFuse key (expected af_live_...)' } });

    const rawBody = await readBody(req);
    const isJson = /application\/json/i.test(req.headers['content-type'] ?? '') && rawBody.length > 0;
    let body = null;
    if (isJson) { try { body = JSON.parse(rawBody.toString('utf8')); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON' } }); } }
    if (req.method === 'POST' && (!body || typeof body !== 'object')) return sendJson(res, 400, { error: { message: 'metered routes require a JSON body' } });

    const model = body?.model ?? null;
    const runId = req.headers['x-agentfuse-run'] ?? body?.metadata?.run_id ?? null;
    const fingerprint = body ? fingerprintBody(body) : null;
    const estimateUsd = body ? estimateRequestCost(model, body, key.policy.preflight ?? 'expected') : 0;
    const snapshot = store.snapshot(key.id, { runId, loopWindowSec: key.policy.loop_window_sec, fingerprint });
    const decision = decide({ key, snapshot, estimateUsd, model });

    if (!decision.allow) {
      if (decision.trip) await trip(key, decision.reason, { scope: decision.scope, limit: decision.limit, spent: decision.spent, detail: decision.detail });
      store.record({ keyId: key.id, runId, provider: provider.name, model, fingerprint, costUsd: 0, status: STATUS_FOR[decision.reason] ?? 402 });
      log.warn('blocked', { key: key.id, reason: decision.reason });
      return sendJson(res, STATUS_FOR[decision.reason] ?? 402, errorBody(decision, key, config.publicUrl), { 'x-agentfuse-blocked': decision.reason });
    }
    for (const a of decision.alerts) alertOnce(key, a.type, a).catch(() => {});

    const upstream = resolveUpstream(key.org_id, provider.name);
    if (!upstream?.apiKey) return sendJson(res, 502, { error: { message: `AgentFuse has no ${provider.name} API key configured${config.mode === 'hosted' ? ' for this org; add one in the dashboard' : ''}` } });

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k) || provider.stripHeaders.includes(k) || k.startsWith('x-agentfuse-')) continue;
      headers[k] = v;
    }
    Object.assign(headers, provider.authHeaders(upstream.apiKey), { 'accept-encoding': 'identity' });
    const outBody = body ? JSON.stringify(provider.prepareBody(body)) : (rawBody.length ? rawBody : undefined);
    if (outBody) headers['content-length'] = String(Buffer.byteLength(outBody));

    const started = Date.now();
    // If the agent hangs up, stop paying for tokens it will never read.
    const abort = new AbortController();
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) { clientGone = true; abort.abort(); } });
    let upstreamRes;
    try {
      upstreamRes = await fetchImpl(upstream.baseUrl + upstreamPath + url.search, { method: req.method, headers, body: outBody, signal: abort.signal });
    } catch (err) {
      if (clientGone) { store.record({ keyId: key.id, runId, provider: provider.name, model, fingerprint, costUsd: 0, status: 499, latencyMs: Date.now() - started }); return; }
      log.error('upstream unreachable', { provider: provider.name, error: err.message });
      return sendJson(res, 502, { error: { message: `upstream ${provider.name} unreachable: ${err.message}` } });
    }

    const resHeaders = {};
    upstreamRes.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k)) resHeaders[k] = v; });
    const isSse = /text\/event-stream/i.test(upstreamRes.headers.get('content-type') ?? '');
    const chunks = [];

    let truncated = false;
    try {
      if (isSse) {
        res.writeHead(upstreamRes.status, { ...resHeaders, 'x-agentfuse-key': key.id });
        for await (const chunk of upstreamRes.body) { chunks.push(chunk); res.write(chunk); }
        res.end();
      } else {
        chunks.push(Buffer.from(await upstreamRes.arrayBuffer()));
      }
    } catch (err) {
      if (!clientGone) throw err;
      truncated = true; // aborted mid-body: meter what we saw, flagged as an estimate
    }

    const raw = Buffer.concat(chunks); // bytes pass through untouched; text decoding is only for metering
    const upstreamIsJson = /application\/json/i.test(upstreamRes.headers.get('content-type') ?? '');
    let usage = null, responseModel = model;
    try {
      if (isSse) usage = provider.usageFromStream(raw.toString('utf8'));
      else if (upstreamRes.ok && upstreamIsJson) { const json = JSON.parse(raw.toString('utf8')); usage = provider.usageFromJson(json); responseModel = json.model ?? model; }
    } catch { /* malformed upstream body */ }

    // No usage in a successful response: charge the worst case so a client cannot profit from suppressing it.
    const estimated = (upstreamRes.ok && !usage) || truncated;
    const cost = usage ? costUsd(responseModel, usage) : (upstreamRes.ok && body ? estimateRequestCost(model, body, 'strict') : 0);
    store.record({ keyId: key.id, runId, provider: provider.name, model: responseModel, fingerprint, inputTokens: usage?.input ?? 0, outputTokens: usage?.output ?? 0, costUsd: cost, estimated, status: truncated ? 499 : upstreamRes.status, latencyMs: Date.now() - started });
    if (truncated) return;

    if (upstreamRes.ok) ops?.track('activated', { tenant: key.org_id, once: true });
    const after = store.snapshot(key.id, { runId });
    const check = postCheck({ key, snapshot: after });
    if (check.trip) await trip(key, check.reason, { scope: check.scope, limit: check.limit, spent: check.spent });

    if (!isSse) {
      const budget = key.policy.monthly_budget_usd;
      res.writeHead(upstreamRes.status, {
        ...resHeaders,
        'content-length': String(raw.length),
        'x-agentfuse-key': key.id,
        'x-agentfuse-cost-usd': cost.toFixed(6),
        'x-agentfuse-month-spend-usd': after.monthUsd.toFixed(4),
        ...(budget != null ? { 'x-agentfuse-month-remaining-usd': Math.max(0, budget - after.monthUsd).toFixed(4) } : {}),
        ...(check.trip ? { 'x-agentfuse-tripped': check.reason } : {}),
      });
      res.end(raw);
    }
  };
}
