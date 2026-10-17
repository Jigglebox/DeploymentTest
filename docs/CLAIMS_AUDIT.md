# Claims audit: advertised vs real (2026-10-18)

Method: every factual claim on the marketing site, the READMEs and the PR description was checked against the code and its tests. Each row is one of **verified** (a test exercises it), **corrected** (copy changed to match the code), or **implemented** (the gap was closed in this pass). A CI test (`packages/shared/test/claims.test.js`) fails the build if retired claims reappear.

| Claim | Where | Status | Evidence |
|---|---|---|---|
| Hard monthly / daily / per-run budgets enforced inline | AgentFuse site, README | verified | `proxy.test.js` end-to-end, per-run |
| Pre-flight blocking before the call is forwarded | AgentFuse | verified | `proxy.test.js` "provider never called" |
| Loop detection trips; key stays blocked until resumed | AgentFuse | verified | `proxy.test.js` loop + resume |
| Exact metering incl. cached tokens, streamed and non-streamed | AgentFuse | verified | streaming + cached-token tests |
| "Every response carries `x-agentfuse-cost-usd`" | AgentFuse site | **corrected** | headers are sent before a stream's usage is known; copy now says non-streamed responses |
| Webhook alerts at 80%, burn rate, every trip | AgentFuse | verified | `policy.test.js` alerts, `proxy.test.js` webhook |
| "Email + Slack alerts" (Pro) | AgentFuse site, README | **implemented** | trip alerts by email via Resend (`AGENTFUSE_ALERT_EMAIL` / org email); Slack is the webhook |
| "SSO" (Team) | AgentFuse site, README | **corrected** | not implemented; removed from the tier |
| "PagerDuty" (Team) | AgentFuse site, README | **corrected** | not implemented; removed (any webhook target still works) |
| "Audit export" (Team) | AgentFuse site, README | **implemented** | `GET /api/export.csv`, org-scoped, tested |
| "mcp-sentinel monitoring included with Team" | AgentFuse + Sentinel pages | **corrected** | no cross-product entitlement exists; removed |
| Hosted mode: bodies forwarded, never stored | AgentFuse FAQ | verified | ledger stores model, tokens, cost, request fingerprint hash only |
| Virtual keys limited to inference routes | AgentFuse README | verified | security test `route_not_allowed` |
| Org isolation, sealed provider keys | AgentFuse README | verified | `hosted.test.js` |
| 21-day campaign: day 0/3/7/14 emails, retries, day 21 close | RecoverKit | verified | `engine.test.js` campaign exhaustion |
| Hard declines never retried; instant retry on card update | RecoverKit | verified | `engine.test.js` hard-decline path |
| Hosted card-update link via Stripe Billing Portal, fresh per email | RecoverKit | verified | review fix + `engine.test.js` |
| "5–9% of subscription revenue lost to failed payments" | RecoverKit site | **corrected** | no primary source on file; replaced with a product fact |
| 20% of recovered, $0 otherwise, invoiced monthly | RecoverKit | **implemented** | `fees.test.js`: Stripe invoice per merchant per period, idempotent |
| Flat $99 plan = capped cost | RecoverKit site | implemented | `RECOVERKIT_FEE_CAP_CENTS` |
| Stripe Connect onboarding | RecoverKit | verified | `connect.test.js` |
| 36.5% MCPTox attack success; OWASP MCP Top 10 #3 | mcp-sentinel site | verified (third-party) | cited in `docs/MARKET_ANALYSIS.md` |
| Detections listed (overrides, hidden-from-user, exfil, invisible text, shadowing, rug-pulls) | mcp-sentinel | verified | `analyzer.test.js`, `cli.test.js` |
| GitHub Action usable from this repo | mcp-sentinel README/site | **corrected** | action ran `npx mcp-sentinel` (unpublished); now runs from the checked-out action path |
| "Nightly re-scans", "org-wide policy", "Slack alert" | Sentinel Cloud copy | **corrected** | re-scans are on a configurable interval (default hourly); no org policy; alerts are a Slack-compatible webhook |
| $47,000 looping-agent incident; 44% with AI spend guardrails | AgentFuse site | verified (third-party) | sources in `docs/MARKET_ANALYSIS.md` |

Not verifiable here and stated as such everywhere: live Stripe, OpenAI and Anthropic calls (no credentials in the build environment).
