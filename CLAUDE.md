@AGENTS.md

# Groundworks — Project Conventions

Small-business accounting (a QuickBooks Online replacement) for teams of
people and AI agents. Everything a person can do in the UI, an agent can do
through the REST API or MCP server, under its own identity, with autonomy
limits and a human review queue. A business signs up for a **workspace**
that holds one or more **companies** (`organizations`); one sign-in reaches
all of them. Security controls are built for SOC 2 (see
`docs/compliance/soc2.md`). Tyler is the domain expert (accounting +
software). Defer on accounting semantics; focus on architecture, correctness,
and execution.

`reference/prototype.jsx` is a 63k-line visual prototype from the earlier
construction-ERP direction. Use it for look-and-feel only.

## Stack

- **Next.js 16 (App Router) + React 19**: Server Components by default
- **TypeScript strict**
- **Tailwind v4 + shadcn/ui (`base-nova`)**: design tokens in `src/app/globals.css`
- **Supabase**: Postgres (managed), Auth (email + password), RLS
- **Drizzle ORM**: schema in `src/lib/db/schema/`, snake_case
- **zod 4** for every input; the same schemas generate the API's JSON Schema
- **decimal.js** for money, **date-fns** for dates

## Architecture rules

1. **Multi-tenant, two levels.** A workspace (`workspaces`) owns companies
   (`organizations.workspace_id`), people (`workspace_members`, role owner /
   admin / member), invitations, and the security policy. Company access is
   a separate `memberships` row per company with its own role. Removing a
   workspace seat closes every company in it. Every domain row carries
   `organization_id`. Services
   always filter by `ctx.actor.organizationId`, and never trust an id from a
   caller: look it up scoped to the org (`requireLineAccounts`,
   `requirePostingAccount`, `loadX(ctx, id)`). The posting engine's v0 check
   re-verifies tenancy of every account / dimension / code on a journal.
   The database is the last wall: every company table has a `tenant_guard`
   trigger (migration 0022) that refuses a reference to another company's
   row and any change of `organization_id`. A migration that adds a company
   table must call `SELECT public.install_tenant_guard('<table>')`;
   `scripts/test-isolation.ts` fails otherwise and attacks every operation
   in the registry from a second workspace.
2. **RLS on every table.** Supabase's REST API exposes `public` with the
   anon key. Every new table needs `ENABLE ROW LEVEL SECURITY` plus a
   member-only SELECT policy in its migration (secrets: no policy at all).
   `scripts/test-rls.ts` fails if any table lacks RLS.
3. **Money is Decimal, never `number`.** DB = `numeric(20,4)`. Use `money()`,
   `sumMoney()`, `toDbMoney()`, `formatMoney()` from `src/lib/money.ts`.
   Inputs use the `amount` schemas in `src/lib/schemas.ts`.
4. **Period math goes through `src/lib/dates.ts`.** Fiscal year start is
   per-organization.
5. **Audit log is append-only.** Every mutation writes a row with
   `...auditFields(ctx.actor)` (who: user / agent / system, which key, which
   channel, IP, user agent) or `...workspaceAuditFields(ctx.actor)` for
   workspace events. Rows carry `workspace_id` always (a trigger fills it
   from `organization_id`) and `organization_id` for company events. Never
   update or delete audit rows.
6. **The ledger is append-only.** Posted journals are immutable (DB
   triggers); corrections are reversals; voids reverse. Balances count
   journals in `LEDGER_STATUSES` (`posted` + `reversed`, see
   `src/lib/gl/ledger.ts`), never `status = 'posted'` alone, or reversals
   double-count.
7. **Subledgers post inside the caller's transaction.** Pass `ctx.tx` to
   `createAndPostJournal(input, tx)` / `reverseJournal(id, opts, tx)`.
8. **Auth.** Humans: Supabase session (verified with `getClaims`), refreshed
   by `src/proxy.ts` (which skips `/api/*`). `requireUser` then applies
   session policy on every request (`src/lib/security/sessions.ts`): not
   revoked, idle and max-age limits, MFA (aal2) when the person enrolled a
   factor or any of their workspaces requires it; the strictest workspace
   wins. Only `/auth/*` pages may use `getUser` without `requireUser`.
   Machines: API keys (`gwk_…`, SHA-256 stored) resolved per request by
   `authenticateApiKey`, which also checks the workspace seat and spends
   the per-key rate limit. Active company = `gw_org` cookie, active
   workspace = `gw_ws`; both re-validated every request.
   Groundworks support (`GROUNDWORKS_SUPPORT_USER_IDS`, MFA in the session)
   sees a workspace only while its owner's grant is live, as a read-only
   viewer (`src/lib/security/support.ts`); each visit is audited.
9. **Security headers.** The proxy sets a per-request CSP with a nonce
   (`src/lib/security/headers.ts`); no inline `<script>`. Static headers
   (HSTS, frame denial, nosniff) come from `next.config.ts`.

## The service layer (how everything works)

```
UI server action ─┐
REST /api/v1  ────┼─> runAs(actor, ctx => service(ctx, input)) ─> Drizzle
MCP /api/mcp  ────┘        one transaction per call; throw = roll back
```

- **Actor** (`src/lib/actor.ts`): who is acting, role, scopes
  (`read`/`write`/`post`/`admin`), channel, agent posting limit.
- **Service functions** take `(ctx: Ctx, input)`, parse input with their
  exported zod schema, call `requirePermission(ctx.actor, scope, minRole,
  "verb phrase")` first, then `requirePostingWithinLimit` before posting.
  They throw `AppError(code, message)` for anything a caller should see.
- **Server actions** are thin: `serviceAction(minRole, ctx => svc(ctx, input))`
  then `revalidatePath`. Never put business logic in an action.
- **Operation registry** (`src/lib/api/operations.ts`): one entry per
  operation (name, method, path, scope, zod input, service call). REST
  routes, MCP tools, and OpenAPI are generated from it. Descriptions are
  read by AI agents: say what it does, when to use it, what to watch for.
- **Creates with `post: true`** go through `postOrQueueForReview`: post if
  allowed, otherwise keep the draft and return a `review` notice.
- **Workspace services** (`src/lib/workspace/service.ts`: companies, people,
  company access, invitations, security policy, access reviews, audit log)
  take a `WsCtx` built from a `WorkspaceActor` (`runAsWorkspace`,
  `requireWorkspaceRole`). Humans only: agents never act at workspace
  level. UI actions use `workspaceAction(minRole, fn)`.

## Directory layout

```
src/
  app/
    (app)/            authenticated UI: dashboard, ar/, ap/, banking/, sales-tax, items, gl,
                      reports/, review, activity, settings/{agents,api-keys,company},
                      pdf/ (route handlers that return customer PDFs),
                      workspace/{people,security,access-review,audit,companies},
                      account/security (own password, MFA, sessions),
                      clients (every workspace + company), support (staff only)
    api/v1/[...path]  REST (generated)        api/mcp  MCP server
    api/cron/daily    recurring journals, invoices + bills, auto-reversal, pruning   api/health  uptime
    signup, onboarding/{,team}   sign-up: workspace + first company, invites
    invite/[token]    accept an invitation
    auth/             login, callback, mfa (TOTP step), signout (route)
  components/         ui/ (shadcn), app-shell/, shared badges + key reveal
  lib/
    actor.ts action.ts errors.ts schemas.ts audit.ts audit-query.ts
    review.ts review-policy.ts email.ts (Resend; no-op when unset)
    workspace/        workspace service + invite-and-email
    security/         sessions (policy, timeouts, revocation), mfa, headers,
                      password rules, support access
    api/              registry, REST, MCP, OpenAPI, executor (dry run + idempotency)
    agents/           key generation, authentication, agent + key service
    ar/ ap/ banking/ gl/ parties/ reports/ sales-tax/   domain services
    company/          company profile + logo (letterhead)
    pdf/              customer PDFs (@react-pdf/renderer, loaded on demand: ESM only)
    db/schema/ db/migrations/   seed/   supabase/   ui/ (server-only page helpers)
scripts/
  test-*.ts           e2e suites (lib/harness.ts for shared setup)
  dev/                test DB reset + Supabase stub, e2e runner, demo seed,
                      UI smoke + fake Supabase Auth (incl. TOTP)
.github/              CI (typecheck, lint, build, e2e, audit), Dependabot, CODEOWNERS
docs/compliance/      SOC 2 control map and checklist
```

## Adding a domain feature (pattern)

1. **Schema** in `src/lib/db/schema/<concern>.ts` with `organization_id`,
   `...timestamps`, and (for documents) `createdBy` / `createdByAgentId`.
   Re-export from `index.ts`.
2. **Migration**: `npm run db:generate`, review the SQL, append RLS
   (`ENABLE ROW LEVEL SECURITY` + `<table>_select_member` policy) and
   `SELECT public.install_tenant_guard('<table>');`.
3. **Service** in `src/lib/<domain>/`: zod schemas + `(ctx, input)` functions
   with permission checks and audit rows.
4. **Registry**: add operations to `src/lib/api/operations.ts`; REST, MCP,
   and OpenAPI pick them up.
5. **UI**: pages call services via `runAs(await requireActor(), …)`; actions
   via `serviceAction`. Add nav to `src/components/app-shell/sidebar.tsx`.
6. **Tests**: an e2e suite in `scripts/test-<domain>.ts` using
   `scripts/lib/harness.ts`. Exercise the role / scope / agent rules too.

## Conventions

- Server Components by default; `"use client"` only for state, effects, or
  browser APIs.
- No ORM abstractions on top of Drizzle; SQL-shaped queries. In correlated
  subqueries name the outer table literally (`"customers"."id"`): Drizzle
  renders single-table selects unqualified and `${table.id}` silently binds
  to the inner table.
- Use `flag` (not `z.coerce.boolean`, where "false" is true) for booleans
  that arrive as query strings; `optionalText` leaves absent fields
  `undefined` so PATCHes don't wipe them.
- `"use server"` files export only async functions and type *declarations*.
  Never `export type { X }` re-exports (Next turns them into runtime
  references); ESLint enforces this.
- No DTOs: Drizzle-inferred types end-to-end. Don't `any`. Don't `@ts-ignore`.
- Error handling at boundaries only (`toAppError`).
- Never point a `<Link>` at a route handler with side effects (exports,
  sign-out) or an expensive one (PDFs): Link prefetches. Use a plain `<a>`
  or a POST form.
- AR balances (invoice open, credit left, payment unapplied, customer
  balance) come from `src/lib/ar/balances.ts` only; never re-derive them
  from payment applications alone, or credits go missing. Sales documents
  share line resolution, tax, and posting in `src/lib/ar/documents.ts`.
  What's billed on an estimate comes from `src/lib/ar/estimate-billing.ts`
  (invoice lines that point at estimate lines, on invoices not voided).
- AP balances (bill open, vendor credit left, vendor balance) come from
  `src/lib/ap/balances.ts` only: a bill is settled by payments and by
  vendor credit applications. Printed checks (`src/lib/ap/checks.ts`) draw
  only on bank accounts; printing writes the check number into
  `reference` and moves `accounts.next_check_number`.
- What's billed on a purchase order comes from `src/lib/ap/po-billing.ts`
  (bill lines that point at PO lines, on bills not voided). POs approve
  through the bill thresholds (scope `ap_bill`) and never touch the ledger.
- 1099 amounts come from `src/lib/ap/form-1099.ts` (accounts carry a
  `form_1099_box`). Full TINs leave the app only through the audited CSV
  export; reports and the API show the last 4.
- Banking amounts are from the account holder's view: + money in, − money
  out (= debit − credit on the account). Reconciliation and overview
  balances use the natural sign (a credit card's balance owed is positive).
  Cleared / reconciled state lives in `gl_line_clearings`, beside the
  immutable ledger, never on `gl_lines`.
- Test fixtures that create companies need a workspace:
  `scripts/lib/workspace.ts` (`testWorkspace`, `deleteFixtures`).

## Commands

```
npm run dev / build / typecheck / lint
npm run db:generate     drizzle: migration from schema diff
npm run db:migrate      apply migrations (DATABASE_URL_MIGRATE or DATABASE_URL)
npm run test:db:reset   recreate TEST_DATABASE_URL with the Supabase stub + migrations
npm run test:e2e        run every scripts/test-*.ts against DATABASE_URL
```
