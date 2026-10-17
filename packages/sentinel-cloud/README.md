# Sentinel Cloud — continuous monitoring for mcp-sentinel

The paid tier behind the free CLI. Every `mcp-sentinel scan --report` from your CI lands here; registered HTTP MCP servers are re-scanned on a schedule. Each scan is compared with the previous one for the same server and your webhook fires on **drift** (a tool's name, description, schema or annotations changed), **new findings** at or above the project's `fail_on` severity, or an **unreachable** server.

```bash
SENTINEL_ADMIN_TOKEN=secret node --no-warnings=ExperimentalWarning packages/sentinel-cloud/src/server.js   # http://localhost:8789/?token=secret
curl -X POST localhost:8789/api/projects -H 'authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"name":"core-agents","alert_webhook":"https://hooks.slack.com/...","fail_on":"high"}'   # -> raw_token sn_...

# from CI (stdio servers can only be scanned where they run)
npx mcp-sentinel scan .mcp.json --report https://sentinel.yourco.com/api/v1/report --report-token sn_...

# hosted re-scans for HTTP servers
curl -X POST localhost:8789/api/projects/<id>/servers -H 'authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"name":"docs-mcp","url":"https://mcp.vendor.com/mcp","headers":{"authorization":"Bearer ..."}}'
```

| Env | Default | |
|---|---|---|
| `PORT` | 8789 | |
| `SENTINEL_DB` | `./data/sentinel-cloud.db` | |
| `SENTINEL_ADMIN_TOKEN` | *(open)* | set in production |
| `SENTINEL_PLAN` | `free` | `free` = 1 project, `pro`/`team` unlimited |
| `SENTINEL_SCAN_INTERVAL_SECONDS` | 3600 | re-scan cadence for registered HTTP servers |
| `SENTINEL_MODE` | `single` | `hosted` = org signup/login, org-scoped projects, per-seat billing |
| `SENTINEL_SESSION_SECRET` | | required in hosted mode (any long random string) |
| `SENTINEL_STRIPE_SECRET_KEY` / `SENTINEL_STRIPE_WEBHOOK_SECRET` / `SENTINEL_PRO_PRICE_ID` | | Stripe per-seat subscription (`SENTINEL_SEAT_PRICE_CENTS`, default 1900, for MRR reporting) |

API: `POST /api/v1/report` (project token) · `GET/POST /api/projects` · `GET/PUT/DELETE /api/projects/:id` · `POST /api/projects/:id/servers` · `GET /api/projects/:id/history/:server` · `POST /api/tick`.

Pricing: $19 per developer per month. In hosted mode a customer signs up at `/signup`, gets one free project, and upgrades with a seat count; the Stripe webhook (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` → `/webhooks/stripe`) sets the plan and seats on the org. Growth metrics (`/growth`, `/api/metrics`) are operator-only via the admin token. Tests: report ingestion with drift and new-finding alerts, token auth, plan gating, scheduled scans against a fake Streamable-HTTP MCP server including a simulated rug-pull and an outage.
