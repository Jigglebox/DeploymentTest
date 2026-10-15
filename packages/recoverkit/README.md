# RecoverKit — failed-payment recovery for Stripe, paid only on what it recovers

> Involuntary churn is money you already lost. RecoverKit wins it back and keeps 20%. If it recovers nothing, you pay nothing.

Connect a Stripe webhook; RecoverKit opens a recovery case for every failed subscription invoice and runs a 21-day campaign: plain-text billing emails with a hosted card-update link, retries timed for bank approval, immediate retry the moment the customer updates their card, and clean closure when Stripe cancels or voids.

## What it does

- **Smart retries**: day 3 / 7 / 14 at 10:00 UTC, idempotent (`invoice.pay` with idempotency keys), coexists with Stripe Smart Retries.
- **Hard-decline awareness**: lost/stolen/expired/invalid cards are *not* retried (pointless, and it hurts your processor standing). They get card-update emails only, then an instant retry on `payment_method.attached`.
- **Hosted card update** via Stripe Billing Portal `payment_method_update` flow: no PCI surface, no custom page.
- **Billing-tone emails** (not marketing-tone): failed → reminder → urgent → final notice → thank-you. Resend out of the box; pluggable.
- **Dashboard**: recovered this month, at-risk, recovery rate, your fee. Per-case timeline. One-click retry / reminder / mark lost.
- Duplicate-webhook safe, SQLite, zero native deps.

## Setup (5 minutes)

1. Stripe → Developers → API keys → **restricted key**: Invoices *write*, Customers *read*, Billing portal *write*. Set `STRIPE_SECRET_KEY`.
2. Stripe → Webhooks → add `https://<host>/webhooks/stripe` with `invoice.payment_failed`, `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible`, `customer.subscription.deleted`, `payment_method.attached`. Set `STRIPE_WEBHOOK_SECRET`.
3. `RESEND_API_KEY` + `RECOVERKIT_FROM_EMAIL` (verified domain) to send real email. Without it emails are logged, not sent.
4. `RECOVERKIT_BUSINESS_NAME`, `RECOVERKIT_SUPPORT_EMAIL`, `RECOVERKIT_RETURN_URL` for the templates.

```bash
STRIPE_SECRET_KEY=rk_live_... STRIPE_WEBHOOK_SECRET=whsec_... RESEND_API_KEY=re_... \
RECOVERKIT_ADMIN_TOKEN=change-me node --no-warnings=ExperimentalWarning packages/recoverkit/src/server.js
# http://localhost:8788/?token=change-me
```

Local testing: `stripe listen --forward-to localhost:8788/webhooks/stripe` then `stripe trigger invoice.payment_failed`.

## Hosted mode: Stripe Connect

Set `STRIPE_CLIENT_ID` (your Connect platform `ca_...`), `STRIPE_SECRET_KEY` (platform key) and `STRIPE_CONNECT_WEBHOOK_SECRET` (a Connect webhook endpoint for the same events). The dashboard shows **Connect a Stripe account**; merchants approve on stripe.com and come back connected. Every case is bound to its merchant's account, retries and portal links run as that account, and `/api/accounts` reports recovered revenue and the fee owed per merchant. `account.application.deauthorized` disconnects them.

## Pricing

**20% of recovered revenue.** $0 setup, $0 monthly. Fee shown live in the dashboard. (`RECOVERKIT_FEE_PCT` is configurable for self-hosters.) Merchants recovering >$5k/mo can switch to a flat $99/mo.

Why this beats the incumbents for SMB SaaS: Churnkey from ~$120/mo + %, Baremetrics Recover from $169/mo. At $20k MRR with 6% involuntary churn, there is ~$1,200/mo at stake; a flat $169 fee is a bet, a 20% success fee is not.

## API

`GET /api/stats` · `GET /api/cases` · `GET /api/cases/:id` · `POST /api/cases/:id/retry` · `POST /api/cases/:id/email?template=reminder` · `POST /api/cases/:id/close` · `POST /api/tick` (run due campaign steps now). Bearer `RECOVERKIT_ADMIN_TOKEN`.

## Tests

`npm test` — engine tests with a fake Stripe and a controllable clock (open → email → retry → recover; hard-decline path; Stripe-side recovery; cancellation; campaign exhaustion; duplicate deliveries) and HTTP tests (signature verification, webhook → dashboard → manual retry → fee).
