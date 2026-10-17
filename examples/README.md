# Examples

| File | Shows |
|---|---|
| `agentfuse-openai.py` | OpenAI Python SDK through AgentFuse: per-run budget header, cost headers, handling a 402 block |
| `agentfuse-anthropic.mjs` | Anthropic Node SDK through AgentFuse with streaming (usage is metered from the stream) and refusal fallbacks |

RecoverKit has no client SDK; test it with the Stripe CLI:

```bash
stripe listen --forward-to localhost:8788/webhooks/stripe     # prints the whsec_... for STRIPE_WEBHOOK_SECRET
stripe trigger invoice.payment_failed                          # opens a recovery case; watch the dashboard
curl -X POST 'localhost:8788/api/tick' -H 'authorization: Bearer <admin token>'   # run due campaign steps now
```

mcp-sentinel: `npx mcp-sentinel scan .mcp.json` in any repo that has MCP servers configured.
