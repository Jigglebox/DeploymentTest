# Revenue Products — three market-validated prototypes

Built from a market-data pass on 15 Oct 2026 (see [docs/MARKET_ANALYSIS.md](docs/MARKET_ANALYSIS.md)). Each product targets a niche with documented willingness to pay, a cheap distribution channel, and pricing aligned to the buyer's pain. All three run on Node 22 with **zero native dependencies** (built-in SQLite), ship with a dashboard, and have an offline test suite.

| Product | One-liner | Pricing model | Why it sells |
|---|---|---|---|
| [**AgentFuse**](packages/agentfuse) | Drop-in LLM proxy that hard-stops agent spend: per-key/per-run budgets, loop detection, burn-rate alerts | Free (3 keys) · Pro $29/mo · Team $99/mo | Runaway-agent bills are the #1 fear in agent ops; only 44% of orgs have AI spend guardrails (Gartner, Mar 2026). Alerts ≠ enforcement. |
| [**RecoverKit**](packages/recoverkit) | Stripe failed-payment recovery: smart retries, hosted card-update links, 4-step email campaign | **20% of recovered revenue, $0 upfront** | Most-cited high-margin micro-SaaS niche (70–90% margins). Performance pricing makes it a no-risk purchase. |
| [**mcp-sentinel**](packages/mcp-sentinel) | Scans MCP servers for tool poisoning / prompt injection; locks tool definitions; fails CI on rug-pulls | Free CLI (MIT) → hosted continuous monitoring $19/dev/mo | OWASP MCP Top 10 lists tool poisoning; 36.5% attack success rate across 45 live servers (MCPTox). Free wedge into AgentFuse. |

## Quickstart

```bash
npm install          # workspaces; no native builds
npm test             # 40 tests, all offline (fake upstreams, fake Stripe, fake MCP server)

# AgentFuse (http://localhost:8787)
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... npm run start:agentfuse

# RecoverKit (http://localhost:8788)
STRIPE_SECRET_KEY=rk_... STRIPE_WEBHOOK_SECRET=whsec_... npm run start:recoverkit

# mcp-sentinel
npm run mcp-sentinel -- scan .mcp.json
```

Docker: `docker compose up` starts AgentFuse and RecoverKit with persistent volumes.

Marketing site: static pages in `site/`, live at https://jigglebox-products.vercel.app (no build step). CI: `.github/workflows/ci.yml` runs the suite and a dogfood scan with mcp-sentinel.

## Repository layout

```
packages/shared        one HTTP toolkit, one SQLite wrapper, one dashboard stylesheet (DRY across products)
packages/agentfuse     proxy + policy engine + admin API + dashboard
packages/recoverkit    Stripe webhook ingestion + recovery engine + campaign + dashboard
packages/mcp-sentinel  MCP client + static analyzer + lockfile + CLI + GitHub Action
docs/                  market analysis and go-to-market notes
```

## Go-to-market (first 30 days)

1. **mcp-sentinel** to npm + GitHub Action; post scan results of popular public MCP servers. Zero-cost distribution, SEO on "MCP security", funnels to AgentFuse.
2. **AgentFuse** hosted beta: `agentfuse.dev`, Stripe Checkout for Pro/Team, open-core self-host. Launch post: "The $47,000 agent loop and the 402 that would have stopped it."
3. **RecoverKit**: list on Stripe App Marketplace + cold outreach to SaaS at $5k–$50k MRR (they lose 5–9% of revenue to involuntary churn; a 20% fee on recovered revenue is pure upside for them).
