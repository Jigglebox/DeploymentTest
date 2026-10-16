// Provider adapters: how to reach upstream, authenticate, and read token usage from
// both JSON and streamed (SSE) responses. Adding a provider = adding one object here.

function sseDataObjects(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch { /* partial chunk */ }
  }
  return out;
}

// Normalised usage: `input` = uncached prompt tokens, `cached` = cache-read tokens.
// OpenAI's prompt_tokens INCLUDES cached tokens; Anthropic's input_tokens EXCLUDES them.
const openaiUsage = (u) => {
  if (!u) return null;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, (u.prompt_tokens ?? u.input_tokens ?? 0) - cached), output: u.completion_tokens ?? u.output_tokens ?? 0, cached };
};

export const providers = {
  openai: {
    name: 'openai',
    prefix: '/openai',
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    stripHeaders: ['authorization', 'x-api-key'],
    // Only inference routes are reachable with a virtual key. Everything else (files, fine-tuning, batches,
    // vector stores, admin) would let a budget-capped agent act with the real account key.
    routes: [['POST', '/v1/chat/completions'], ['POST', '/v1/responses'], ['POST', '/v1/embeddings'], ['GET', '/v1/models']],
    /** Streamed responses must include a usage chunk; the client may not opt out of metering. */
    prepareBody: (body) => (body?.stream === true ? { ...body, stream_options: { ...(body.stream_options ?? {}), include_usage: true } } : body),
    usageFromJson: (json) => openaiUsage(json?.usage ?? json?.response?.usage),
    usageFromStream: (text) => {
      let usage = null;
      for (const ev of sseDataObjects(text)) {
        const u = ev.usage ?? ev.response?.usage; // chat completions chunk | responses API `response.completed`
        if (u) usage = openaiUsage(u);
      }
      return usage;
    },
  },
  anthropic: {
    name: 'anthropic',
    prefix: '/anthropic',
    authHeaders: (apiKey) => ({ 'x-api-key': apiKey }),
    stripHeaders: ['authorization', 'x-api-key'],
    routes: [['POST', '/v1/messages'], ['POST', '/v1/messages/count_tokens'], ['GET', '/v1/models']],
    prepareBody: (body) => body,
    usageFromJson: (json) => json?.usage ? {
      input: json.usage.input_tokens ?? 0,
      output: json.usage.output_tokens ?? 0,
      cached: json.usage.cache_read_input_tokens ?? 0,
      cacheWrite: json.usage.cache_creation_input_tokens ?? 0,
    } : null,
    usageFromStream: (text) => {
      let input = 0, output = 0, cached = 0, cacheWrite = 0, seen = false;
      for (const ev of sseDataObjects(text)) {
        if (ev.type === 'message_start' && ev.message?.usage) {
          seen = true;
          input = ev.message.usage.input_tokens ?? 0;
          cached = ev.message.usage.cache_read_input_tokens ?? 0;
          cacheWrite = ev.message.usage.cache_creation_input_tokens ?? 0;
        }
        if (ev.type === 'message_delta' && ev.usage) { seen = true; output = ev.usage.output_tokens ?? output; }
      }
      return seen ? { input, output, cached, cacheWrite } : null;
    },
  },
};

/** Is this method+path on the provider's allow-list (plus any AGENTFUSE_EXTRA_ROUTES_JSON entries)? */
export function routeAllowed(provider, method, upstreamPath, extra = []) {
  const path = upstreamPath.replace(/\/+$/, '');
  return [...provider.routes, ...extra.filter((r) => r[2] === provider.name).map((r) => [r[0], r[1]])]
    .some(([m, p]) => m === method && (p === path || (p.endsWith('/*') && path.startsWith(p.slice(0, -1)))));
}

/** Resolve provider from the proxied path, e.g. '/openai/v1/chat/completions'. */
export function resolveProvider(pathname) {
  for (const p of Object.values(providers)) {
    if (pathname === p.prefix || pathname.startsWith(p.prefix + '/')) {
      return { provider: p, upstreamPath: pathname.slice(p.prefix.length) || '/' };
    }
  }
  return null;
}

/** Pull the virtual key from whichever header the client SDK uses. */
export function extractClientKey(headers) {
  const bearer = String(headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  return bearer || String(headers['x-api-key'] ?? '').trim() || null;
}
