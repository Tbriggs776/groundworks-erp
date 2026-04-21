@AGENTS.md

# Groundworks ERP — Project Conventions

A construction ERP for middle-market contractors and subcontractors.
Positioning: Foundation Software + ServiceTitan replacement. Tyler is the
domain expert (accounting + construction + software). Defer on domain
semantics; focus on architecture, correctness, and execution.

A 63k-line visual prototype lives at `reference/prototype.jsx`. Treat it as a
UX/design spec — copy look-and-feel, rebuild every module cleanly.

## Stack

- **Next.js 16 (App Router) + React 19** — Server Components by default
- **TypeScript strict**
- **Tailwind v4 + shadcn/ui (`base-nova`)** — design tokens in `src/app/globals.css`
- **Supabase** — Postgres (managed), Auth (magic link), Storage, RLS
- **Drizzle ORM** — schema in `src/lib/db/schema/`, snake_case
- **decimal.js** for money, **date-fns** for dates

## Architecture rules

1. **Multi-tenant.** Every domain row carries `organization_id`. RLS policies
   enforce tenant isolation as a safety net. App code still filters by org.
2. **Money is Decimal, never `number`.** DB column = `numeric(20,4)`. Use
   `money()`, `sumMoney()`, `toDbMoney()`, `formatMoney()` from `src/lib/money.ts`.
3. **Period math goes through `src/lib/dates.ts`.** Fiscal year start is
   per-organization; never hardcode calendar year.
4. **Audit log is append-only.** Every mutating action emits a row in
   `audit_log`. Never update or delete audit rows.
5. **GL (when built) is append-only too.** Corrections happen via reversing
   entries, not mutations. Period locks prevent posting to closed periods.
6. **Auth = Supabase.** The Next.js 16 **proxy** (`src/proxy.ts`, formerly
   `middleware.ts` in older Next versions) refreshes session cookies on every
   request. Authenticated routes live under `(app)/`; the `(app)/layout.tsx`
   double-checks the session server-side.

## Directory layout

```
src/
  app/
    (app)/          → authenticated routes (dashboard, gl, jobs, ap, …)
    auth/           → login + OAuth callback
    globals.css     → design tokens + shadcn theme
    layout.tsx      → root (fonts, dark class)
  components/
    ui/             → shadcn primitives
    app-shell/      → sidebar, topbar, shell wrapper
  lib/
    db/
      client.ts     → Drizzle client (pooled connection)
      schema/       → table definitions, one file per concern
    supabase/       → browser + server + middleware clients
    money.ts
    dates.ts
    utils.ts        → shadcn cn()
  proxy.ts          → Next 16 proxy: Supabase session refresh + route gating
reference/
  prototype.jsx     → 63k-line design reference (do not edit)
drizzle.config.ts
.env.example
```

## Adding a domain module (pattern)

1. **Schema.** New file in `src/lib/db/schema/<concern>.ts`. Every table has
   `organization_id` FK, `...timestamps`. Export types (`$inferSelect`).
   Re-export from `src/lib/db/schema/index.ts`.
2. **Migration.** `npm run db:generate` → review SQL → commit.
3. **Routes.** Under `src/app/(app)/<module>/…` — Server Components by
   default. Client components only for interactive UI.
4. **Queries.** Server-side via the Drizzle `db` client, always filtering
   `where eq(table.organizationId, orgId)`.
5. **Mutations.** Server actions (`"use server"`) or route handlers. Emit an
   `audit_log` row on every state change.
6. **Nav.** Add the route to `src/components/app-shell/sidebar.tsx`; remove
   the `soon` flag when it's usable.

## Conventions

- Server Components by default. `"use client"` only when you need state,
  effects, or browser APIs.
- No ORM abstractions on top of Drizzle. Write SQL-shaped queries; reports
  will want raw SQL anyway.
- No DTOs. Use Drizzle-inferred types end-to-end.
- Don't `any`. Don't `@ts-ignore`.
- Error handling at boundaries only — trust internal code.
- Match existing code style; don't invent new patterns without reason.

## Commands

```
npm run dev             # Next.js dev server
npm run build           # production build
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run db:generate     # drizzle: generate migration from schema diff
npm run db:push         # drizzle: push schema directly (dev only)
npm run db:studio       # drizzle studio (DB browser)
```
