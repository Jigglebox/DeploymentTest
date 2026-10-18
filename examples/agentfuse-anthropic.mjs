// Run an Anthropic-SDK agent through AgentFuse. The proxy is transparent to the SDK:
//   npm install @anthropic-ai/sdk
//   ANTHROPIC_BASE_URL=http://localhost:8787/anthropic ANTHROPIC_API_KEY=af_live_... node examples/agentfuse-anthropic.mjs
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY

try {
  const stream = client.beta.messages.stream({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if a safety classifier declines, Anthropic re-runs on a fallback model in the same call
    messages: [{ role: 'user', content: 'In two sentences, why should an agent have a spend circuit breaker?' }],
  }, { headers: { 'X-AgentFuse-Run': process.env.RUN_ID ?? 'demo-run' } });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') console.log('declined:', msg.stop_details?.category);
  for (const block of msg.content) if (block.type === 'text') console.log(block.text);
  console.log('usage:', msg.usage.input_tokens, 'in /', msg.usage.output_tokens, 'out (metered by AgentFuse from the stream)');
} catch (err) {
  if (err instanceof Anthropic.APIError && err.status === 402) console.log('AgentFuse blocked the request:', err.error?.error?.code, '-', err.message);
  else throw err;
}
