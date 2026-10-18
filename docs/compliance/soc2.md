# SOC 2 readiness

How Groundworks supports a SOC 2 audit: what the product already does, what
the platforms underneath it provide, and what the company running it has
to own.

## First, what SOC 2 is

- SOC 2 is a report from a licensed CPA firm about a **company's** controls,
  not a certificate a codebase can hold. The auditor tests the product
  *and* how the business runs it.
- **Type I** checks that controls are designed well at one point in time.
  **Type II** checks that they actually operated over a window, usually 3
  to 12 months. Customers will ask for Type II.
- The criteria are the AICPA Trust Services Criteria. **Security** (the
  "Common Criteria", CC1 to CC9) is required. Availability, Confidentiality,
  Processing Integrity, and Privacy are optional; for accounting software,
  Availability, Confidentiality, and Processing Integrity are worth adding.

## Controls built into the product

| Criteria | Control | Where it lives | Evidence an auditor can pull |
|---|---|---|---|
| CC6.1 | Role-based access: workspace roles (owner, admin, member) and per-company roles (owner, admin, accountant, bookkeeper, viewer) | `src/lib/actor.ts`, `src/lib/workspace/service.ts` | People page; access review CSV |
| CC6.1 | Least privilege for AI agents: own identity, role capped below admin, autonomy level, per-document posting limit, human review queue | `src/lib/agents/`, `src/lib/review-policy.ts` | Agents page; audit rows with `actor_type = agent` |
| CC6.1 | Tenant isolation: every query scoped to the company; RLS on every table as a safety net | `src/lib/db/migrations/0019`, `0021`; `scripts/test-rls.ts` | CI run of the RLS suite |
| CC6.1 | Two-step verification (TOTP); a workspace can require it; enforced on every request, not just at sign-in | `src/lib/security/sessions.ts`, `src/app/auth/mfa` | Security policy page; `auth.mfa.verified` events |
| CC6.1 | Session control: idle timeout, maximum session length, revocation, "sign out everywhere else"; strictest policy across workspaces wins | `src/lib/security/sessions.ts` | `auth.session.ended` events with the reason |
| CC6.1 | API keys: random 40 character secrets, only SHA-256 stored, scoped, optional expiry with a workspace maximum, revocable, per-key rate limit | `src/lib/agents/keys.ts`, `src/lib/api/rate-limit.ts` | API Keys page; access review "live keys" list |
| CC6.2 | Provisioning: invitations are email-bound, single use, expire in 7 days, stored hashed, and can be limited to company email domains | `src/lib/workspace/service.ts` | `invitation.*` events |
| CC6.2, CC6.3 | Deprovisioning: removing someone closes every company at once and kills their personal API keys on the next request | `updatePerson`, `authenticateApiKey` | `workspace.member.removed` events; `scripts/test-workspaces.ts` |
| CC6.3 | Periodic access reviews: snapshot of people, roles, MFA status, last activity, agents, and live keys; sign-off freezes it | `/workspace/access-review` | Review history + CSV per review |
| CC6.6 | Web hardening: per-request CSP nonce, HSTS, frame denial, nosniff, strict referrer policy; zod validation on every input; CSV formula-injection guard | `src/lib/security/headers.ts`, `src/lib/schemas.ts`, `src/lib/ui/csv.ts` | Response headers; `scripts/dev/ui-smoke.mjs` checks them |
| CC6.7 | Encryption in transit (TLS via Vercel, HSTS) and at rest (Supabase Postgres, AES-256) | Platform | Vendor SOC 2 reports |
| CC7.1 | Vulnerability management: dependency audit in CI, weekly Dependabot updates | `.github/workflows/ci.yml`, `.github/dependabot.yml` | CI history; Dependabot PRs |
| CC7.2 | Audit trail: append-only (a database trigger rejects edits), records who (person, agent, or system), which key, which channel, IP address, and device for every change and every sign-in; exportable | `src/lib/audit.ts`, `/workspace/audit` | CSV export (the export itself is audited) |
| CC8.1 | Change management: CI on every PR (typecheck, lint, build, 13 e2e suites, audit), PR risk checklist, code owners | `.github/` | Merged PRs with green checks and approvals |
| A1.2 | Health endpoint for uptime monitoring | `/api/health` | Monitor history |
| PI1 | Accounting integrity: double-entry posting engine with 12 checks, posted journals immutable (DB triggers), corrections by reversal, period locks | `src/lib/gl/` | `scripts/test-posting.ts` |

Audit events worth knowing: `auth.signed_in`, `auth.signed_out`,
`auth.session.ended` (with `idle_timeout`, `max_age`, `revoked_by_user`),
`auth.mfa.verified`, `auth.sessions.revoked`, `workspace.created`,
`workspace.security_policy.updated` (before and after),
`workspace.member.removed` / `restored` / `updated`, `membership.granted` /
`updated` / `revoked`, `invitation.created` / `accepted` / `revoked`,
`api_key.created` / `revoked`, `agent.created` / `updated`,
`workspace.access_review.completed`, `workspace.audit_log.exported`, plus
every bookkeeping change (`ar.invoice.posted`, `gl.journal.drafted`, …).

## Platform settings to turn on

These live outside the code. Each one is cheap and auditors look for all
of them.

**Supabase**
- Point-in-time recovery (PITR) on the production project, and a restore
  test at least once a year
- MFA on every Supabase dashboard account; least privilege for org members
- Auth: enable TOTP MFA; use asymmetric JWT signing keys; custom SMTP for
  sign-in emails from your domain
- Network restrictions on the database; SSL enforced
- Apply all migrations (0021 adds the workspace and session tables)

**Vercel**
- Team SSO or required 2FA; least privilege for members
- Mark secrets (`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
  `CRON_SECRET`, database URLs) as Sensitive
- Deployment protection on preview deployments
- Log drains to a store with 1 year retention

**GitHub**
- Require 2FA for the organization
- Branch protection on `main`: required status checks (CI), at least one
  approving review, review from code owners, no force pushes
- Secret scanning and Dependabot alerts on

**Email (Resend or your SMTP provider)**
- Verify the sending domain with SPF, DKIM, and DMARC

## What the company owns

The product can't do these; an auditor will ask for each.

- **Policies**, adopted and reviewed yearly: information security, access
  control, change management, incident response, business continuity and
  disaster recovery, vendor management, risk assessment, data
  classification and retention, acceptable use, encryption
- **People**: background checks, security awareness training at hire and
  yearly, signed policy acknowledgments, onboarding and offboarding
  checklists for your own staff
- **Risk assessment** once a year, with a risk register
- **Vendor management**: collect SOC 2 reports from Supabase, Vercel,
  GitHub, and your email provider each year
- **Incident response**: a written plan, an on-call path, and one tabletop
  exercise a year
- **Access reviews**: run the in-app review every quarter (the record is
  kept for you), and review your own Supabase, Vercel, and GitHub access too
- **Penetration test** once a year by an outside firm
- **Asset inventory**: laptops with disk encryption, screen lock, and
  endpoint protection

## Suggested path

1. Turn on the platform settings above and apply the migrations.
2. Pick a compliance platform (Vanta, Drata, or Secureframe). They supply
   policy templates, connect to GitHub, Vercel, and Supabase to collect
   evidence automatically, and introduce auditors.
3. Fix what the platform flags, then do a **Type I** audit.
4. Run the controls for 3 to 6 months, then the **Type II** audit.

Typical timeline: 2 to 3 months to Type I, another 3 to 6 months to Type II.

## Known gaps (roadmap)

- **SSO enforcement**: SAML sign-in works through Supabase SSO, but a
  workspace can't yet *require* it for its domain. SCIM provisioning is
  not built.
- **IP allowlists** per workspace
- **Customer data export and deletion** workflows (a company's full export,
  and closing a company with a retention period)
- **Security alerting**: notify admins of unusual sign-ins or many failed
  MFA attempts
- **Audit log streaming** to a SIEM or object storage, and a hash chain for
  tamper evidence beyond the append-only trigger
- **Admin MFA reset** for someone who lost their device (today: Supabase
  dashboard)
