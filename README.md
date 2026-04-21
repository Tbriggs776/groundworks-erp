# Groundworks ERP

Construction ERP for middle-market contractors and subcontractors. Combines
construction accounting (GL, job cost, AP, AR, AIA billing, payroll) with
field-service operations (dispatch, equipment, mobile) plus CRM, BI, and
AI layers — in one platform.

## Status

Tier 0 (platform slab): **scaffolded**. Next.js 16 + Supabase + Drizzle, with
multi-tenant schema, magic-link auth, audit log, money/date utilities, and
the app shell. No domain modules yet.

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

## Getting started

### 1. Install

```bash
npm install
```

### 2. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. In **Settings → API**, copy `URL`, `anon` key, and `service_role` key.
3. In **Settings → Database → Connection Pooling**, copy the **Transaction**
   pooled connection string (port 6543).
4. Also grab the **Direct** connection string (port 5432) — needed for
   migrations.

### 3. Environment

```bash
cp .env.example .env.local
# fill in the values from step 2
```

### 4. Database schema

```bash
npm run db:push        # syncs the Drizzle schema to your Supabase DB
```

Later, for proper migration-based workflow:

```bash
npm run db:generate    # creates a migration file under src/lib/db/migrations
npm run db:migrate     # (to be added) applies migrations
```

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
`/auth/login`. Enter your email, click the magic link, and you'll land on
the dashboard.

## Project layout

```
src/
  app/            — routes (App Router), auth + (app) group
  components/     — UI (shadcn + app-shell)
  lib/            — db, supabase clients, money, dates
  middleware.ts   — Supabase session refresh + route gating
reference/        — 63k-line visual prototype (design spec)
```

## Roadmap

The platform lands in tiered releases. See [CLAUDE.md](./CLAUDE.md) for the
full architecture plan.

- [x] **Tier 0 — Platform:** multi-tenant, auth, audit, money/dates, shell
- [ ] **Tier 1 — Core ledger:** chart of accounts, double-entry GL, period close
- [ ] **Tier 1 — Master data:** customers, vendors, employees, cost codes, jobs
- [ ] **Tier 2 — The wedge:** estimating, commitments, change orders, AP, job cost
- [ ] **Tier 3 — Revenue side:** AR, AIA/SOV, retainage, WIP reporting
- [ ] **Tier 4+ —** payroll, dispatch, equipment, CRM, BI, mobile PWA, AI agents

## License

Proprietary — all rights reserved.
