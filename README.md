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

**Sales**: customers, products & services, invoices (draft → open → paid),
receive payment (explicit or auto-applied oldest first), early-pay discounts

**Expenses**: vendors (1099 flags), bills with amount-tiered approval routing,
bill payments with discounts

**People and agents**
- Roles: owner, admin, accountant, bookkeeper, viewer; invite links;
  multiple organizations per person with a switcher
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
| Tools | 61 operations: accounts, journals, customers, items, invoices, payments, vendors, bills, bill payments, reports, review queue, activity |
| Money / dates | decimal strings (`"1250.00"`), `YYYY-MM-DD` |
| Dry run | `X-Dry-Run: true` / `dry_run: true`: the whole operation runs, GL posting included, then rolls back |
| Retries | `Idempotency-Key` header / `idempotency_key` arg: a create runs once per key |
| Errors | `{ error: { code, message, details, requestId } }`; in MCP, `isError` results starting `Error (<code>)` |
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

You need a Supabase project for auth (magic links). In **Authentication → URL
Configuration** add `http://localhost:3000/**` to the redirect URLs.

### Tests

The e2e suites run against any Postgres. A Supabase auth stub is included, so
a throwaway local database works:

```bash
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/gw_test
npm run test:db:reset                         # drop, recreate, migrate
DATABASE_URL=$TEST_DATABASE_URL npm run test:e2e
```

12 suites: posting engine, recurring/allocations/budgets, reports, FX,
parties, bills, bill payments, sales, agents + keys, REST + MCP, team, RLS.

`scripts/dev/seed-demo.ts` creates a demo org and prints owner and agent keys
for poking at the API. `scripts/dev/ui-smoke.mjs` drives every page in
Chromium (see the file header).

## Production (Vercel + Supabase)

Environment variables (Production + Preview):

| Key | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | mark Sensitive |
| `DATABASE_URL` | **pooled** connection (port 6543); the client uses `prepare: false` |
| `NEXT_PUBLIC_APP_URL` | public URL; used in invite links and connection snippets |
| `CRON_SECRET` | required for the daily job (recurring entries, auto-reversals, key pruning) |

Migrations run from your machine against the direct (port 5432) connection:
`DATABASE_URL_MIGRATE=… npm run db:migrate`. Add your production URL to
Supabase's redirect URLs.

## Roadmap to QuickBooks parity

- **Banking**: bank feeds (Plaid), CSV/OFX import, categorization rules that
  agents can apply, reconciliation
- **Sales**: sales tax, estimates, sales receipts, credit memos and refunds,
  recurring invoices, invoice PDF + email, online payments, statements
- **Expenses**: checks / card charges without a bill, receipt capture,
  purchase orders, 1099 reporting
- **Inventory**: quantity on hand and COGS
- **Reports**: cash flow statement, P&L by class / location, sales by
  customer / item, expenses by vendor
- **Migration**: QuickBooks Online importer (chart, customers, vendors, items,
  open invoices and bills, opening balances)
- **Agent platform**: OAuth for MCP (so claude.ai connectors work without
  pasting a key), webhooks / events (`invoice.paid`…), per-type approval
  policies, attachments, per-key rate limits, emailed invites

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

## License

Proprietary. All rights reserved.
