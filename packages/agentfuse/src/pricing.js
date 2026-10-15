// USD per 1M tokens. Longest-prefix match so dated snapshots ("gpt-4o-2024-08-06") resolve.
// Override or extend at runtime with AGENTFUSE_PRICING_JSON='{"my-model":{"input":1,"output":2}}'.
import { config } from './config.js';

const BASE_PRICES = {
  // Anthropic first-party API rates (Oct 2026). cached = cache-read price.
  'claude-fable-5-1': { input: 10, output: 50, cached: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cached: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cached: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cached: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cached: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cached: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cached: 0.5 },
  'claude-opus-4': { input: 15, output: 75, cached: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cached: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cached: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cached: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cached: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cached: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cached: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cached: 0.08 },
  // OpenAI list prices (verify against openai.com/pricing; override if they move).
  'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005 },
  'gpt-5-mini': { input: 0.25, output: 2, cached: 0.025 },
  'gpt-5': { input: 1.25, output: 10, cached: 0.125 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cached: 0.025 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1 },
  'gpt-4.1': { input: 2, output: 8, cached: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cached: 1.25 },
  'o4-mini': { input: 1.1, output: 4.4, cached: 0.275 },
  'o3-mini': { input: 1.1, output: 4.4, cached: 0.55 },
  'o3': { input: 2, output: 8, cached: 0.5 },
};

let overrides = {};
try { overrides = config.pricingOverrides ? JSON.parse(config.pricingOverrides) : {}; } catch { overrides = {}; }
export const PRICES = { ...BASE_PRICES, ...overrides };
const KEYS_BY_LENGTH = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceFor(model) {
  const m = String(model ?? '').toLowerCase();
  const hit = KEYS_BY_LENGTH.find((k) => m === k || m.startsWith(k + '-') || m.startsWith(k + '@') || m.startsWith(k + ':'));
  if (hit) return { ...PRICES[hit], known: true, matched: hit };
  return { ...config.unknownModelPricePerM, known: false, matched: null };
}

/** usage: { input (uncached), output, cached?, cacheWrite? } -> USD. Provider adapters normalise `input` to exclude cached tokens. */
export function costUsd(model, usage) {
  if (!usage) return 0;
  const p = priceFor(model);
  const cachedPrice = p.cached ?? p.input * 0.1;
  const cost = ((usage.input ?? 0) * p.input + (usage.cached ?? 0) * cachedPrice + (usage.cacheWrite ?? 0) * p.input * 1.25 + (usage.output ?? 0) * p.output) / 1e6;
  return Number(cost.toFixed(8));
}

/** Rough token count without a tokenizer: ~4 chars per token across English/code/JSON. */
export const estimateTokens = (value) => Math.ceil(JSON.stringify(value ?? '').length / 4);

/**
 * Pre-flight cost estimate used to block a call BEFORE it is sent.
 * mode 'expected' assumes a typical completion; 'strict' assumes max_tokens is fully used.
 */
export function estimateRequestCost(model, body, mode = 'expected') {
  const promptTokens = estimateTokens({ m: body?.messages, i: body?.input, s: body?.system, t: body?.tools, p: body?.prompt });
  const maxOut = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? 1024;
  const outTokens = mode === 'strict' ? maxOut : Math.min(maxOut, 2048);
  return costUsd(model, { input: promptTokens, output: outTokens });
}
