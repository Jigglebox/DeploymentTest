# AgentFuse — the circuit breaker for AI agent spend

> Alerts tell you after the money is gone. AgentFuse returns a `402` before the next call leaves your network.

A drop-in proxy for the OpenAI and Anthropic APIs. Point your SDK at it, give each agent its own key with a budget, and AgentFuse meters every request, blocks the one that would breach the cap, trips a breaker when something loops, and pages you.

## What it does

- **Hard budgets** per key: monthly, daily and per-run (`X-AgentFuse-Run` header). Enforced inline, not by a cron that reads a billing export.
- **Pre-flight blocking**: estimates a request's cost from prompt size and `max_tokens` and refuses it *before* forwarding if it would cross the cap. `preflight: strict` assumes worst case.
- **Loop detection**: N identical requests within a window → breaker opens. The $47k incident was four agents repeating themselves for 11 days.
- **Breaker semantics**: a tripped key stays blocked until a human resumes it in the dashboard or API. Webhook (Slack-compatible) on trip, 80% threshold and abnormal burn rate; trips also go out by email (`AGENTFUSE_ALERT_EMAIL` or the org's email in hosted mode, via `RESEND_API_KEY`).
- **CSV audit export**: `GET /api/export.csv?from=&to=` returns the org's full ledger for the window.
- **Exact metering** for streamed and non-streamed responses on both providers (OpenAI chat + responses APIs, Anthropic messages incl. cache tokens). Response headers carry `x-agentfuse-cost-usd` and `x-agentfuse-month-remaining-usd`.
- **Model allow-lists** and per-minute rate limits.
- **Route allow-list.** A virtual key can reach only inference routes (`chat/completions`, `responses`, `embeddings`, `models`; Anthropic `messages`, `count_tokens`, `models`). Files, fine-tuning, batches, vector stores and admin endpoints return 403, so a leaked agent key never becomes the account key. Extend with `AGENTFUSE_EXTRA_ROUTES_JSON='[["POST","/v1/audio/speech","openai"]]'`.
- **Metering cannot be opted out of.** `stream_options.include_usage` is forced on; a successful response without usage is charged at the worst case (full `max_tokens`).
- Dashboard + JSON admin API. SQLite storage, zero native deps, one process.

## Two-minute setup

```bash
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... AGENTFUSE_ADMIN_TOKEN=change-me \
  node --no-warnings=ExperimentalWarning packages/agentfuse/src/server.js
# open http://localhost:8787/?token=change-me  → create a key → copy af_live_...
```

Then in your agent (no code changes):

```bash
# OpenAI SDKs
OPENAI_BASE_URL=http://localhost:8787/openai/v1   OPENAI_API_KEY=af_live_...
# Anthropic SDKs
ANTHROPIC_BASE_URL=http://localhost:8787/anthropic ANTHROPIC_API_KEY=af_live_...
```

Blocked calls return HTTP 402 and a JSON error both SDKs surface cleanly:

```json
{ "error": { "code": "budget_would_exceed", "message": "AgentFuse blocked this request: budget_would_exceed (this call (~$0.4100) would push monthly spend past $50). Resume at http://localhost:8787/keys/key_…", "scope": "monthly", "limit": 50, "spent": 49.7 } }
```

## Admin API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/keys` | `{name, policy:{monthly_budget_usd, daily_budget_usd, per_run_budget_usd, rpm_limit, loop_max_repeats, loop_window_sec, allowed_models, preflight}}` → returns `raw_key` once |
| GET | `/api/keys`, `/api/keys/:id` | keys with live spend snapshot; recent ledger |
| PUT | `/api/keys/:id/policy` | change limits |
| POST | `/api/keys/:id/trip`, `/resume` | open/close the breaker |
| GET | `/api/events`, `/api/usage` | audit trail; totals by model |

Auth: `Authorization: Bearer $AGENTFUSE_ADMIN_TOKEN` (or `?token=` for the dashboard).

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` | 8787 | |
| `AGENTFUSE_DB` | `./data/agentfuse.db` | SQLite file |
| `AGENTFUSE_ADMIN_TOKEN` | *(empty = open)* | set this in production |
| `AGENTFUSE_PUBLIC_URL` | `http://localhost:8787` | used in error messages/alerts |
| `AGENTFUSE_ALERT_WEBHOOK` | | Slack or any JSON endpoint |
| `AGENTFUSE_PLAN` | `free` | `free`=3 keys, `pro`=25, `team`=unlimited |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | | real upstream credentials (never given to agents) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | | |
| `AGENTFUSE_PRICING_JSON` | | override/add model prices, `{"model":{"input":$/M,"output":$/M}}` |
| `AGENTFUSE_UNKNOWN_INPUT_PRICE` / `_OUTPUT_PRICE` | 5 / 25 | conservative price for unknown models |

## Pricing

| | Free | Pro $29/mo | Team $99/mo |
|---|---|---|---|
| Agent keys | 3 | 25 | unlimited |
| Hosting | self-host | hosted or self-host | hosted, CSV audit export, priority support |
| Alerts | webhook | webhook + email | webhook + email |

## Hosted mode (multi-tenant SaaS)

`AGENTFUSE_MODE=hosted` turns one instance into a service: customers sign up at `/signup`, get a dashboard session plus an org API token (`af_org_...`), paste their own OpenAI/Anthropic keys (stored sealed with `AGENTFUSE_MASTER_KEY` using AES-256-GCM, never returned), create agent keys under their org, and upgrade their own plan. Every key, ledger row, event and budget is scoped to the org; another org gets 404 on your keys. Generate the master key once: `openssl rand -hex 32`.

```bash
AGENTFUSE_MODE=hosted AGENTFUSE_MASTER_KEY=$(openssl rand -hex 32) AGENTFUSE_PUBLIC_URL=https://fuse.example.com \
AGENTFUSE_STRIPE_SECRET_KEY=... AGENTFUSE_STRIPE_WEBHOOK_SECRET=... AGENTFUSE_PRO_PRICE_ID=... AGENTFUSE_TEAM_PRICE_ID=... \
node --no-warnings=ExperimentalWarning packages/agentfuse/src/server.js
```

Org API: `GET /api/me` · `GET/PUT/DELETE /api/providers/:name` · everything under `/api/keys` and `/api/billing`, authenticated with `Authorization: Bearer af_org_...` or the session cookie. Single-tenant mode (the default) is unchanged: admin token, provider keys from the environment.

## Self-serve upgrades

Set `AGENTFUSE_STRIPE_SECRET_KEY`, `AGENTFUSE_STRIPE_WEBHOOK_SECRET`, `AGENTFUSE_PRO_PRICE_ID`, `AGENTFUSE_TEAM_PRICE_ID` and point a Stripe webhook (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`) at `/webhooks/stripe`. The dashboard shows an **Upgrade** button; `POST /api/billing/checkout {plan}` returns a Checkout URL; the webhook flips the stored plan and the key limit immediately. `GET /api/billing` reports the effective plan. Self-hosters without billing keep using `AGENTFUSE_PLAN`.

## Tests

`npm test` — policy engine unit tests and end-to-end proxy tests against a fake upstream (metering, pre-flight block, trip/resume, loop detection, per-run budgets, streaming on both providers, plan gating).
