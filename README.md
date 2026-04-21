# Groundworks ERP

Construction ERP for middle-market contractors and subcontractors. Combines
construction accounting (GL, job cost, AP, AR, AIA billing, payroll) with
field-service operations (dispatch, equipment, mobile) plus CRM, BI, and
AI layers — in one platform.

## Status

- **Tier 0 — Platform slab:** ✅ Next.js 16, Supabase, Drizzle, multi-tenant
  schema, magic-link auth, audit log, money + period utilities, app shell.
- **Tier 1 — Identity hardening + onboarding:** ✅ RLS on all tables, signup
  trigger, onboarding flow creates org + owner membership + system
  dimensions + source codes + (optionally) a ~70-account contractor CoA
  template.
- **Tier 1 — GL masters:** ✅ Accounts, dimensions, fiscal periods, multi-
  currency, exchange rates, source/reason/number series. 19 tables, 11 enums
  at BC parity.
- **Tier 1 — Journals + posting engine:** 🚧 in progress (Chunk B).

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

## Getting started (local dev)

### 1. Install

```bash
npm install
```

### 2. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. From **Settings → API Keys**, copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
3. Click the **Connect** button (top of dashboard) → copy:
   - **Direct connection** URI → both `DATABASE_URL` and `DATABASE_URL_MIGRATE`
     (local dev is fine with the direct URL; production uses pooled — see below)

### 3. Environment

```bash
cp .env.example .env.local
# fill in the values, replacing [YOUR-PASSWORD]
```

### 4. Database schema

```bash
npm run db:migrate     # applies migrations in src/lib/db/migrations/
```

### 5. Supabase auth URLs

In the Supabase dashboard → **Authentication → URL Configuration**:
- **Site URL:** `http://localhost:3000`
- **Redirect URLs:** add `http://localhost:3000/**`

(Magic links won't return you to the app without this.)

### 6. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
`/auth/login`. Enter your email, click the magic link, and land on the
dashboard (or onboarding, if it's your first login).

## Production deploy — Vercel

The app is Vercel-ready; deploy is via GitHub → Vercel auto-build.

### 1. Environment variables

In Vercel → **Settings → Environment Variables** set these for
**Production + Preview + Development**:

| Key | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | same as local |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same as local |
| `SUPABASE_SERVICE_ROLE_KEY` | same as local — mark **Sensitive** |
| `DATABASE_URL` | **MUST be pooled URL** (see below) |
| `NEXT_PUBLIC_APP_URL` | `https://your-project.vercel.app` |

**Do NOT add `DATABASE_URL_MIGRATE` to Vercel** — migrations run locally,
not on deploy.

### 2. Pooled `DATABASE_URL` (production)

Direct connections will exhaust under serverless load. In Supabase →
**Connect → Transaction pooler** (not Direct), copy that URI:

```
postgresql://postgres.YOUR-REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Port **6543**, user includes the project ref. Our Drizzle client is
configured with `prepare: false` which is required for pgBouncer
transaction-mode pooling.

### 3. Supabase auth URLs (production)

Supabase → **Authentication → URL Configuration**:
- Add your Vercel URL to **Redirect URLs**: `https://your-project.vercel.app/**`
- Optionally set **Site URL** to your production URL

Without this, magic links sent from the production app redirect to localhost
and break.

### 4. Migrations on deploy?

No — migrations stay a local concern. Run `npm run db:migrate` from your
laptop after merging schema changes to `main`, before the Vercel build
finishes deploying. (A future iteration may move this into a CI step once
the schema stabilizes.)

## Project layout

```
src/
  app/              — routes (App Router), auth + (app) group + onboarding
  components/       — UI (shadcn + app-shell)
  lib/
    db/             — Drizzle client, schema (19 tables), migrations
    supabase/       — browser + server + middleware clients
    seed/           — per-org defaults (system dimensions, contractor CoA)
    auth/           — password hashing (bcryptjs) for secondary secrets
    auth.ts         — user/org helpers, role gating
    money.ts        — decimal.js wrapper for currency
    dates.ts        — fiscal-period helpers
  proxy.ts          — Next 16 "proxy" (was middleware): session + route gating
scripts/            — DB migrate, inspect, status scripts (tsx)
reference/          — 63k-line visual prototype (design spec, do not edit)
```

## Commands

```
npm run dev             Next.js dev server
npm run build           Production build
npm run typecheck       tsc --noEmit
npm run lint            ESLint

npm run db:generate     Generate a migration from schema diffs
npm run db:migrate      Apply pending migrations (idempotent)
npm run db:studio       Open Drizzle Studio (DB browser) — points at DATABASE_URL
npm run db:push         Direct schema push (dev prototyping only — bypasses migrations)
```

## Roadmap

- [x] **Tier 0 — Platform:** multi-tenant, auth, audit, money/dates, shell
- [x] **Tier 1.1 — Hardening:** RLS, signup trigger, onboarding flow
- [x] **Tier 1.2 — GL masters:** accounts, dimensions, fiscal periods, currency
- [ ] **Tier 1.3 — Journals + posting engine**
- [ ] **Tier 1.4 — Recurring / allocation / budget**
- [ ] **Tier 1.5 — UI: CoA / Dimensions / Fiscal / Manual JE**
- [ ] **Tier 1.6 — Reports: Trial Balance, GL Detail, BS, IS**
- [ ] **Tier 1.7 — FX revaluation**
- [ ] **Tier 2 — Master data:** customers, vendors, employees, cost codes, jobs
- [ ] **Tier 3 — Preconstruction → Job Cost wedge:** estimating, commitments,
  change orders, AP → job cost
- [ ] **Tier 4 — Billing side:** AR, AIA/SOV, retainage, WIP reporting
- [ ] **Tier 5+ —** payroll, dispatch, equipment, CRM, BI, mobile PWA, AI

## License

Proprietary — all rights reserved.
