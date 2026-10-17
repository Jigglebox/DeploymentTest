# Operations: errors, feedback, and the improvement loop

Goal: every failure and every piece of customer feedback ends up in one queue that gets worked, so the products improve continuously without anyone watching dashboards.

## 1. Capture (in-product, automatic)

Each product runs the shared ops module (`packages/shared/src/ops.js`):

- **Errors**: any unhandled 500 and any process-level uncaught exception is recorded with a fingerprint (product + normalised message + top stack frame), occurrence count, first/last seen and route. Repeats bump the count; they never create duplicates.
- **Feedback**: `/feedback` in every dashboard (signed-in org or admin), `POST /api/feedback` (API), and `POST /api/feedback/public` (the marketing site form, CORS-enabled, 10 submissions per IP per hour). Categories: bug, feature, billing, praise, other.
- **Read it**: `GET /api/ops/errors`, `GET /api/ops/feedback` (admin / org auth).

## 2. Sync (scheduled, hourly)

With `OPS_GITHUB_TOKEN` and `OPS_GITHUB_REPO` set, the scheduler files one GitHub issue per new error fingerprint (label `auto-error` + product) and per feedback item (labels `feedback`, category, product). Contact details stay in the product database, never in the issue. `POST /api/ops/sync` forces a run.

A digest goes to `OPS_ALERT_WEBHOOK` once per `OPS_DIGEST_INTERVAL_SECONDS` (default daily): occurrences, signatures, new signatures, feedback count.

## 3. Triage and fix (scheduled Claude session, daily)

A scheduled task on this account starts a fresh Claude Code session every weekday morning against this repository. Its brief:

1. List open issues labelled `auto-error` or `feedback`, newest first.
2. For each `auto-error`: reproduce from the stack and route, fix the root cause on a branch with a regression test, open a PR that references the issue, and comment on the issue with the PR link. If it cannot be reproduced, say so on the issue and leave it open with label `needs-info`.
3. For each `feedback`: `bug` → same as above; `billing` → check the Stripe webhook and plan code paths, fix or explain; `feature` → if it is small and consistent with the product's pricing promise, implement it with tests and a PR; otherwise write a short scoped proposal on the issue and label `roadmap`; `praise` → label `wontfix-not-needed` and close with thanks.
4. Never merge. Never change pricing or delete customer data. Keep each PR to one issue.
5. Finish with one summary comment on a tracking issue titled "Ops triage log".

## 4. Release

PRs are merged by a human after CI. mcp-sentinel ships to npm on a `mcp-sentinel-v*` tag. Hosted services redeploy from `main`.

## Environment

| Variable | Purpose |
|---|---|
| `OPS_GITHUB_TOKEN` | fine-grained token with Issues: write on `OPS_GITHUB_REPO` |
| `OPS_GITHUB_REPO` | `owner/repo` that receives the issues |
| `OPS_ALERT_WEBHOOK` | Slack-compatible webhook for the digest (falls back to the product's alert webhook) |
| `OPS_DIGEST_INTERVAL_SECONDS` | default 86400 |
