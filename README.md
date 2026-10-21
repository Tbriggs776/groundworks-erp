# Groundworks

Small-business accounting (a QuickBooks Online replacement) built for teams of
people **and AI agents**. Real double-entry books with an immutable ledger,
plus a first-class REST API and MCP server so Claude, Cursor, or any agent can
do the bookkeeping, with humans approving what posts.

## What's in it

**Books**
- Chart of accounts (QuickBooks-shaped default), classes / locations /
  departments / projects, fiscal periods with soft and hard close
- Journal entries: 12-check posting engine, DB-enforced immutability,
  reversals, recurring entries, allocations, budgets, multi-currency + FX
  revaluation
- Reports: profit & loss, balance sheet, trial balance, GL detail, AR aging,
  AP aging

**Sales**
- Customers, products & services, invoices (draft → open → paid), sales
  receipts for cash sales, early-pay discounts
- Estimates with progress invoicing: bill what's left, a percent of each
  line, or a custom amount per line; billing can't pass the estimate, and
  a fully billed estimate closes on its own
- Recurring invoices: scheduled (created and posted on their date),
  reminders (a draft in the review queue), or unscheduled templates used by
  hand; any invoice can be made recurring
- PDFs of invoices, estimates, sales receipts, and credit memos with the
  company's letterhead and logo; balance forward customer statements (one
  customer or all at once) that tie to the ledger
- Receive payment: explicit or auto-applied oldest first; an overpayment
  stays as the customer's credit
- Credit memos and customer credits: applied to open invoices
  automatically (oldest first, a company setting) or by hand, or paid out
  with a refund
- Refunds for returned items, or out of a customer's credit
- Sales tax with manual rates, like QuickBooks: agencies, single and
  combined rates, taxable items, exempt customers, tax on the taxable total
  (rounded once), a liability report by agency, and recording payments

**Expenses**: vendors (1099 flags), bills with amount-tiered approval routing,
bill payments with discounts

**Inventory**
- Inventory items with quantity on hand, an asset account, a cost of goods
  sold account, a reorder point, and opening stock
- Costing method per company, set once: FIFO, weighted average, or specific
  identification by lot (lot numbers on every line, optional expiration
  dates, each lot costed on its own)
- Bills, expenses, checks, and purchase orders buy into stock (purchase
  orders by quantity received); invoices and sales receipts post cost of
  goods sold; credit memos and refunds return stock; vendor credits send it
  back; adjustments for counts, damage, and found stock
- Backdating and voids recost every later sale automatically; selling past
  zero is allowed (with a warning) and the next stock in fills it
- Reports: inventory valuation (as of any date, ties to the ledger),
  valuation detail (every change by day), and stock status (reorder, on
  order, expiring lots); a stock history page per item

**Banking**
- Expenses, checks, deposits (group payments from Undeposited Funds), and
  transfers, including paying a credit card
- Import bank and card statements (CSV, OFX, QFX, Web Connect); lines
  already imported are skipped
- For review: match each line to what's in the books (suggested by amount
  and date), add it as a new transaction, or exclude it; undo any of these
- Bank rules that categorize lines, or record them at import
- Reconcile to a statement: tick what cleared until the difference is zero;
  reconciled items can't be voided; only the latest reconciliation can be
  undone (admins, with a reason)
- Register with running balance and cleared / reconciled marks

**Moving from QuickBooks Online**
- Import a QuickBooks company in a few clicks: sign in with Intuit, and a
  new company is made in your workspace with its books brought across
- Company details and fiscal year, the chart of accounts (with QuickBooks'
  numbers where they're free), customers, vendors, products and services,
  terms, classes, departments (as locations), and journal entries with
  QuickBooks' exact amounts, so the books tie to QuickBooks
- Runs in batches while the page is open; pausing, closing the page, or a
  failed batch loses nothing, and it picks up where it stopped
- Anything that didn't come across is listed with the reason, to review

**Workspaces: one sign-in, many companies**
- Sign up in a minute: name, work email, company. No password; a sign-in
  link by email (or Google / Microsoft / SAML SSO when enabled)
- A workspace holds any number of companies, each with its own books
- Invite people once and choose their role in each company; invites go by
  email and work once, for that address
- Switch companies from the top bar

**Security (built for SOC 2)**
- Two-step verification (authenticator app); a workspace can require it
- Idle sign-out and maximum session length, set per workspace; "sign out
  everywhere else"
- Allowed email domains for invitations; API key lifetime limits
- Quarterly access reviews with a frozen record of who had what
- Workspace audit log of every sign-in and change, with IP and device,
  exportable to CSV
- See [docs/compliance/soc2.md](./docs/compliance/soc2.md)

**People and agents**
- Company roles: owner, admin, accountant, bookkeeper, viewer
- **Agents**: AI teammates with their own identity, role, API keys, and an
  autonomy level:
  - *Read only*: look things up, run reports
  - *Draft for review*: create anything; nothing touches the ledger until a
    person posts it from the **review queue**
  - *Post*: post within its role, up to a per-document limit; bigger items
    wait for review
- Agents can never void, manage people, or mint keys; an agent can't approve
  a bill it created
- Every action is in the audit trail with who (person / agent / system), which
  API key, and which channel (UI / API / MCP)

## Connect an agent

1. **Settings → Agents → New agent**, pick its autonomy, then **Create key**.
   The key (`gwk_…`) is shown once with copy-paste setup.
2. Connect it:

```bash
# Claude Code
claude mcp add --transport http groundworks https://YOUR-APP/api/mcp \
  --header "Authorization: Bearer gwk_…"
```

```jsonc
// Any MCP client config (Cursor, Claude Desktop via mcp-remote)
{
  "mcpServers": {
    "groundworks": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-APP/api/mcp",
               "--header", "Authorization: Bearer gwk_…"]
    }
  }
}
```

```bash
# Plain REST
curl https://YOUR-APP/api/v1/me -H "Authorization: Bearer gwk_…"
```

### API and MCP at a glance

| | |
|---|---|
| MCP | `POST /api/mcp`, Streamable HTTP, stateless JSON; protocol 2024-11-05 → 2025-11-25 |
| REST | `/api/v1/…`; spec at `/api/v1/openapi.json` |
| Auth | `Authorization: Bearer gwk_…` (or `x-api-key`) |
| Tools | 229 operations: QuickBooks import status, accounts, journals, customers, items, estimates, invoices, recurring invoices, payments, sales receipts, credit memos and credits, refunds, sales tax, vendors, purchase orders, bills, recurring bills, bill payments, vendor credits and refunds, printed checks, banking (transactions, statement import, For review, rules, reconciliation), month-end close (checklist, close and reopen, checklist items), inventory (costing method, lots, item stock, adjustments, valuation, valuation detail, stock status), email (documents and payment reminders with PDFs, send history, settings), reports (P&L by month, class, and budget; cash flow; sales by customer and item; expenses by vendor; open invoices and unpaid bills; 1099s; audit trail; changes after close; any report as CSV or PDF), review queue, activity |
| Money / dates | decimal strings (`"1250.00"`), `YYYY-MM-DD` |
| Dry run | `X-Dry-Run: true` / `dry_run: true`: the whole operation runs, GL posting included, then rolls back |
| Retries | `Idempotency-Key` header / `idempotency_key` arg: a create runs once per key |
| Errors | `{ error: { code, message, details, requestId } }`; in MCP, `isError` results starting `Error (<code>)` |
| Rate limit | 600 requests a minute per key (`API_RATE_LIMIT_PER_MINUTE`); over it: `429` with `Retry-After` |
| Review | `post: true` on a create posts when allowed, otherwise keeps the draft and returns a `review` notice |

The REST routes, MCP tools, and OpenAPI spec are all generated from one
registry: `src/lib/api/operations.ts`.

## Getting started (local dev)

```bash
npm install
cp .env.example .env.local     # fill in Supabase + database values
npm run db:migrate             # apply migrations
npm run dev
```

You need a Supabase project for auth. In the Supabase dashboard:

- **Authentication → Sign In / Providers → Email**: turn **Confirm email**
  off (new accounts sign in at once) and set the minimum password length
  to 10 (matches `src/lib/security/password.ts`)
- **Authentication → URL Configuration**: add `http://localhost:3000/**` to
  the redirect URLs (password-reset links come back through `/auth/callback`)
- **Authentication → Multi-Factor**: enable TOTP (authenticator apps)
- **Authentication → Emails → SMTP**: use your own SMTP (Resend works) so
  reset emails aren't held to Supabase's built-in hourly limit
- Optional: enable Google / Azure providers and set
  `NEXT_PUBLIC_AUTH_PROVIDERS=google,azure`; SAML SSO with
  `NEXT_PUBLIC_AUTH_SSO=1`

Open `/signup` to create your workspace and first company.

### Tests

The e2e suites run against any Postgres. A Supabase auth stub is included, so
a throwaway local database works:

```bash
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/gw_test
npm run test:db:reset                         # drop, recreate, migrate
DATABASE_URL=$TEST_DATABASE_URL npm run test:e2e
```

30 suites: QuickBooks import (against a fake QuickBooks: sign-in state,
sealed tokens, resumable batches through failures, throttling, expired
tokens, paging, and what came across), posting engine,
inventory (FIFO and average, backdating, negative stock, voids, closed
periods, adjustments, opening stock, purchase orders, valuation tie-out),
lots (specific identification, expiring lots, vendor credits of stock,
purchase orders by quantity, stock status, valuation detail), recurring/allocations/budgets, reports,
email (every document type, templates, who may send where, failed sends,
scheduled reminders, signed delivery events),
month-end close (checklist, soft and hard close, closing password,
adjusting and override entries, reopen, changes after close, year end),
financial statements (P&L columns, budget vs actual, cash flow, contra
accounts, exports), detail reports (sales by customer and item, expenses by
vendor, open invoices, unpaid bills, audit trail), FX,
parties, bills, bill payments, vendor credits and refunds (plus card
payments and printed checks), purchase orders (approval, partial
billing), recurring bills, 1099s, invoices and payments, sales (tax, receipts,
credit memos, credits, refunds, the liability report), estimates and
recurring invoices (progress invoicing, the daily run), documents (company
profile and logo, PDFs, statements), banking (transactions, statement
import, For review, rules, reconciliation), agents + keys, REST + MCP, RLS,
workspaces (sign-up, invites, access, policy, access reviews), session
security (timeouts, MFA, revocation, rate limits), workspace isolation
(every API operation attacked from a second workspace, plus the database
guards), and support access. CI runs them all on every
pull request (`.github/workflows/ci.yml`).

`scripts/dev/seed-demo.ts` creates a demo workspace and company and prints
owner and agent keys for poking at the API. `scripts/dev/ui-smoke.mjs`
drives every page and the main flows in Chromium, including two-step
verification, against a fake Supabase Auth (see the file headers).

## Production (Vercel + Supabase)

Environment variables (Production + Preview):

| Key | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | mark Sensitive |
| `DATABASE_URL` | **pooled** connection (port 6543); the client uses `prepare: false` |
| `NEXT_PUBLIC_APP_URL` | public URL; used in invite links and connection snippets |
| `CRON_SECRET` | required for the daily job (recurring entries, auto-reversals, pruning) |
| `RESEND_API_KEY`, `EMAIL_FROM` | invitation emails; without them, invites show a link to copy |
| `NEXT_PUBLIC_AUTH_PROVIDERS`, `NEXT_PUBLIC_AUTH_SSO` | optional extra sign-in methods |
| `API_RATE_LIMIT_PER_MINUTE` | optional, default 600 |
| `GROUNDWORKS_SUPPORT_USER_IDS` | optional; your support team's user ids (see Support access) |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` | QuickBooks import: your Intuit app's keys (mark the secret Sensitive); `sandbox` or `production` |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`); seals QuickBooks tokens. Mark Sensitive; changing it disconnects every QuickBooks connection |

Migrations run from your machine against the direct (port 5432) connection:
`DATABASE_URL_MIGRATE=… npm run db:migrate`. Add your production URL to
Supabase's redirect URLs. Point an uptime monitor at `/api/health`.

### QuickBooks import

1. In the Intuit developer portal, open your app and add the redirect URI
   `https://<your app>/api/qbo/callback` (exactly `NEXT_PUBLIC_APP_URL` +
   `/api/qbo/callback`) under its Development and Production settings.
2. The app needs the **Accounting** scope only.
3. Set `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` (`sandbox`
   until Intuit approves production keys), and `APP_ENCRYPTION_KEY`.
4. Workspace admins see **Import from QuickBooks** on the Workspace page;
   progress and notes are under **Settings → QuickBooks Import**.

### Support access

Nobody at Groundworks can see inside a customer's workspace by default.

- A workspace owner turns it on under **Workspace → Security** for 1, 3, or
  7 days; an owner or admin can turn it off at any time.
- Your support team are the user ids in `GROUNDWORKS_SUPPORT_USER_IDS`.
  They need two-step verification, then find granted workspaces at
  `/support`. Access is read-only (viewer) and ends on expiry.
- Every grant, revocation, and visit is in that workspace's audit log and
  listed on its Security page.

## Roadmap to QuickBooks parity

- **Banking**: live bank feeds (Plaid), split a statement line across
  categories, attachments on bank transactions
- **Sales**: estimates, recurring invoices, invoice and statement PDFs +
  email, online payments, automated sales tax rates
- **Expenses**: vendor credits, receipt capture, purchase orders, recurring
  bills, 1099 reporting
- **Inventory**: serial numbers, multiple locations and transfers, assemblies
  and bundles
- **Reports**: cash flow statement, P&L by class / location, sales by
  customer / item, expenses by vendor
- **Migration**: QuickBooks Online import of sales and purchase history
  (invoices, payments, deposits, bills, bill payments, expenses, checks,
  transfers, credits and refunds), then estimates, purchase orders, stock on
  hand, and a month-by-month tie-out against QuickBooks' trial balance
- **Agent platform**: OAuth for MCP (so claude.ai connectors work without
  pasting a key), webhooks / events (`invoice.paid`…), per-type approval
  policies, attachments
- **Accounts**: billing and plans, SSO enforcement and SCIM, IP allowlists,
  company data export and deletion, consolidated reports across companies

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

## License

Proprietary. All rights reserved.
