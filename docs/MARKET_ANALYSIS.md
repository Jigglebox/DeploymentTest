# Market analysis — what to build for a high probability of profit (Oct 2026)

Method: web research across indie-SaaS revenue datasets, category trend trackers, marketplace reports, security research and incident write-ups, then scoring candidates on (a) evidence of willingness to pay, (b) distribution cost, (c) build cost for a solo team with Claude Code, (d) pricing alignment with the buyer's pain. Numbers below come from vendor blogs and secondary reports unless noted; treat as directional.

## Base rates (why most products fail)

- Of ~3,787 bootstrapped SaaS tracked by TrustMRR/BigIdeasDB, the 2025 cohort median MRR is **$168**; 23.5% exceed $1k; median MoM growth is 0%. ([source](https://bigideasdb.com/state-of-indie-saas-revenue-2026))
- Browser extensions: 57% earn $0; 6.3% clear $1k/mo; average $295/mo. The outliers monetise via paid tiers or lifetime deals, not ads. ([source](https://bigideasdb.com/how-to-monetize-a-chrome-extension))
- Acquisition multiples for sub-$1M ARR: ~2.5–4× revenue; average listing ~2.6× trailing revenue, 10.7× trailing profit. High-margin, low-maintenance products are what buyers pay for. ([source](https://beancount.io/blog/2026/07/11/bootstrapped-saas-valuation-multiples-2026-acquire-com-indie-founders-guide))

Implication: pick niches with a **specific, dollar-denominated pain** and a **distribution channel that is already there**.

## Candidate 1 — AI agent spend enforcement (chosen: AgentFuse)

- The widely cited incident: four LangChain agents looped for 11 days (264 h) in Nov 2025 and produced a **$47,000** bill; post-mortem root causes were "no per-agent budget caps" and "no mechanism to terminate before the next API call". ([source](https://dev.to/waxell/the-47000-agent-loop-why-token-budget-alerts-arent-budget-enforcement-389i))
- Gartner (Mar 2026): only **44%** of organisations have financial guardrails / AI FinOps. FinOps Foundation 2026: 98% of FinOps practices now manage AI spend (up from ~⅓ two years earlier). ([source](https://www.revefi.com/blog/ai-spend-guardrails))
- Enterprise AI spend +483% 2024→2026 while per-token prices fell ~80%; most orgs can't attribute consumption to agents. Budget enforcement "belongs at the gateway, post-hoc alerts fire too late." ([source](https://www.mintmcp.com/blog/llm-cost-optimization-agent-teams))
- AI-agent observability market estimated $0.4B (2025) → $7.1B (2035). ([source](https://www.astuteanalytica.com/de/industry-report/ai-agent-observability-market))
- Competitive gap: LiteLLM/Portkey/Helicone are full gateways (heavy, team-level). Nobody sells a **two-minute drop-in circuit breaker** with pre-flight blocking, loop detection and a resumable "tripped" state. That is the wedge.

Pricing: Free (3 keys, self-host) / Pro $29 / Team $99. Comparable: Helicone & Portkey price $20–$49 per seat for far more surface; a single avoided incident pays for years.

## Candidate 2 — Failed-payment recovery for Stripe (chosen: RecoverKit)

- Payment-recovery/dunning is the most frequently cited profitable micro-SaaS niche in 2026 roundups, with 70–90% margins. ([source](https://bigideasdb.com/most-profitable-saas-niches-2026), [source](https://superframeworks.com/articles/best-micro-saas-ideas-solopreneurs))
- Incumbent pricing: Churnkey from ~$120/mo + % recovered (previously $300–2,000/mo), Baremetrics Recover from $169/mo, Stunning $50–200/mo. Newer entrants (FlyCode, RecoverFlow) use **pay-on-recovery** (RecoverFlow: 25% of recovered, $0 upfront). ([source](https://www.flycode.com/blog/best-failed-payment-recovery-tools-2026), [source](https://fungies.io/best-dunning-software-saas), [source](https://www.indiehackers.com/post/i-built-a-tool-that-takes-25-of-the-money-it-recovers-and-0-if-it-recovers-nothing-3c8ef66e23))
- The buyer's math is trivial: involuntary churn is money already lost; a 20% fee on recovered revenue is 80% found money. Zero-risk purchase → high close rate on cold outreach.
- Differentiators built: hard-decline detection (skips futile retries on lost/stolen/expired cards, which protects the merchant's processor standing), immediate retry on `payment_method.attached`, idempotent retries, Stripe Billing Portal card-update links (no PCI surface).

Pricing: 20% of recovered revenue, nothing up front. Optional flat $99/mo cap for merchants recovering >$5k/mo.

## Candidate 3 — MCP tool-poisoning scanner (chosen: mcp-sentinel, as the free wedge)

- MCP: 97M+ downloads within months of early-2026 release, 1,000+ active servers. ([source](https://www.astuteanalytica.com/de/industry-report/ai-agent-observability-market))
- MCPTox benchmark: **36.5% average tool-poisoning attack success rate** across 45 live servers and 20 LLMs. OWASP lists tool poisoning as #3 in the MCP Top 10. Major IDEs (Cursor, Claude Code, Copilot, Gemini CLI) auto-execute project-defined MCP servers with developer privileges. ([source](https://mcpplaygroundonline.com/blog/mcp-security-tool-poisoning-owasp-top-10-mcp-scan), [source](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-auto-execution-20260701/))
- Existing scanners (Snyk agent-scan, Invariant mcp-scan) are free, so the scanner itself is not the product; it is distribution. Monetisation is continuous monitoring + alerting (hosted), bundled with AgentFuse.

## Rejected candidates

- **SMB pricing tools** (fastest-growing AI category per SBE Council) — needs proprietary data feeds; long build before first dollar.
- **Vertical CRMs** — reliable but require domain sales; no leverage from this environment.
- **Generic AI content tools** — highest average MRR but most crowded; free tiers of ChatGPT/Claude/Gemini cap willingness to pay.
- **Paid Claude Code plugins** — no confirmed payment mechanism exists in the marketplace yet.

## Other sources consulted

[SBE Council AI tools survey](https://sbecouncil.org/2026/04/25/the-ai-tools-small-businesses-are-using/) · [Micro SaaS trends 2026](https://bigideasdb.com/micro-saas-trends-2026) · [SaaS trends: fastest-growing categories](https://saasytrends.com/blog/saas-trends) · [Shopify app economy](https://revenuehunt.com/state-of-the-shopify-app-economy/) · [LegalZoom compliance survey](https://briefglance.com/companies/legalzoom-com-inc/pulses/31451) · [Snyk agent-scan](https://github.com/snyk/agent-scan) · [Latitude observability comparison](https://latitude.so/blog/ai-agent-observability-tools-developer-comparison-guide-2026-devto) · [Plushcap developer trends](https://www.plushcap.com/trends/reports/developer-trends-apr-13-2026) · [Claude Code plugin marketplace guide](https://www.alexcloudstar.com/blog/claude-code-plugin-marketplace-skills-2026)
