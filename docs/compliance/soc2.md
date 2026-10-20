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
| CC6.1 | Tenant isolation: every query scoped to the company; RLS on every table; database guards refuse any reference to another company's row and any move between companies; every API operation is attacked from a second workspace in CI | `src/lib/db/migrations/0019`, `0021`, `0022`; `scripts/test-rls.ts`, `scripts/test-isolation.ts` | CI runs of the RLS and isolation suites |
| CC6.1 | Vendor access: Groundworks support can't see a workspace unless its owner turns support access on, for 1 to 7 days; read-only; staff need two-step verification; every grant, revocation, and visit is logged where the owner sees it | `src/lib/security/support.ts`, Workspace → Security | `support_access.*` events; `scripts/test-support-access.ts` |
| CC6.1 | Passwords: at least 10 characters, hashed by Supabase Auth (bcrypt), sign-in attempts rate limited per IP by Supabase; setting a new password (My security or a reset link) signs out every other session and is audited | `src/lib/security/password.ts`, `src/app/(app)/account/security/actions.ts` | `auth.password.changed` events; Supabase Auth logs for failed sign-ins |
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
| CC8.1 | Change management: CI on every PR (typecheck, lint, build, 26 e2e suites, audit), PR risk checklist, code owners | `.github/` | Merged PRs with green checks and approvals |
| A1.2 | Health endpoint for uptime monitoring | `/api/health` | Monitor history |
| PI1 | Accounting integrity: double-entry posting engine with 12 checks, posted journals immutable (DB triggers), corrections by reversal, period locks | `src/lib/gl/` | `scripts/test-posting.ts` |
| PI1 | Month-end close: a checklist runs before a period closes (bank and card accounts reconciled, nothing in For review, no drafts, AR and AP tied to their control accounts, Undeposited Funds and holding accounts empty, recurring templates run, the company's own items signed off); closing past open items takes a note. Only people (admins and owners) close or reopen; agents can't. Soft closed periods take only adjusting and reversing entries; hard closed ones take the owner-set closing password, and every override post is flagged. Reopening needs a reason. Anything posted into a period after it was first closed shows on the changes after close report | `src/lib/gl/close.ts`, `src/lib/gl/validations.ts` | `fiscal_period.*`, `fiscal_year.*`, `close_task.*`, `company.closing_password_*`, `gl.period.override_post` events; `scripts/test-close.ts` |
| PI1 | Sales tax: each document freezes its tax by component when saved (a later rate change never rewrites it); tax is computed once on the taxable total; the liability report nets credit memos and refunds and drops voided documents | `src/lib/sales-tax/`, `src/lib/ar/documents.ts` | Liability report; `scripts/test-sales.ts` |
| PI1 | Progress invoicing and recurring invoices: invoice lines remember the estimate line they bill, and billing can't pass the estimate (checked on every save, under a row lock); voiding returns the amount. Scheduled invoices post through the same engine as a person's; an agent can only schedule invoices within its posting limit, and a refused post leaves a draft in the review queue | `src/lib/ar/estimate-billing.ts`, `src/lib/ar/recurring-invoices.ts` | `ar.estimate.*`, `ar.recurring_invoice.*` events; `scripts/test-estimates.ts` |
| PI1 | Customer statements: built from AR documents and their voids, each counted on the date its journal posted, so a statement's opening and closing balances equal the customer's AR in the ledger on those dates; aging prints only when it adds up to the amount due; internal notes (void reasons, memos) never reach the customer | `src/lib/ar/statements.ts`, `src/lib/pdf/` | `scripts/test-documents.ts` (ledger tie-out) |
| PI1 | Purchase orders: approved through the same amount tiers as bills (an agent never approves, even its own); bills made from a PO remember the PO lines they bill, and no line can be billed past its amount (checked on every bill save under a row lock); voiding or deleting the bill gives the amount back | `src/lib/ap/purchase-orders.ts`, `src/lib/ap/po-billing.ts` | `ap.purchase_order.*` events; `scripts/test-purchase-orders.ts` |
| PI1 | Financial statements: every report is built once as a table that the screen, CSV, and PDF all render, so they can't disagree; P&L columns (month, class, budget) sum to the single-column P&L; the cash flow statement ties to the change in cash accounts and says so if it doesn't; sales by customer and expenses by vendor tie to the P&L; open invoices and unpaid bills tie to the agings; the audit trail report exports the company's log for any range; every download is audited | `src/lib/reports/` | `reports.exported` events; `scripts/test-statements.ts`, `scripts/test-detail-reports.ts` |
| PI1 | 1099 reporting: amounts come from posted payments by payment date (card payments and voids left out), split over bill lines by the 1099 box of each line's account; thresholds follow the tax year. Taxpayer ids show only their last 4 digits in the app and API; the full number appears only in the CSV export, which needs accountant or higher and is audited | `src/lib/ap/form-1099.ts` | `reports.1099.exported`, `gl.account.1099_box_set` events; `scripts/test-1099.ts` |
| PI1 | Recurring bills: the daily run creates each bill and submits it for approval (or leaves a draft in the review queue); bills never post without the normal approval | `src/lib/ap/recurring-bills.ts` | `ap.recurring_bill.*` events; `scripts/test-recurring-bills.ts` |
| PI1 | Vendor credits and checks: a credit pays down a bill only up to what each side has left (checked under row locks); a credit already refunded can't be voided until the refund is; vendor balances and AP aging net unused credits and tie to the AP account. Checks print only from a bank account, take consecutive numbers from the account's counter, and a reprint clears the old number first | `src/lib/ap/` | `ap.credit.*`, `ap.vendor_credit.*`, `ap.vendor_refund.*`, `ap.checks.printed`, `ap.check.queued` events; `scripts/test-vendor-credits.ts` |
| PI1 | Bank reconciliation: statements imported with duplicate detection; each line matched, added, or excluded (and every step undoable and audited); a reconciliation completes only at a zero difference; reconciled items can't be voided or unmatched; only the latest reconciliation can be undone, by an admin, with a reason | `src/lib/banking/` | Reconciliation reports; `bank.*` events; `scripts/test-banking.ts` |

Audit events worth knowing: `auth.signed_in`, `auth.signed_out`,
`auth.session.ended` (with `idle_timeout`, `max_age`, `revoked_by_user`),
`auth.mfa.verified`, `auth.sessions.revoked`, `auth.password.changed`,
`support_access.granted` / `revoked` / `opened`, `workspace.created`,
`workspace.security_policy.updated` (before and after),
`workspace.member.removed` / `restored` / `updated`, `membership.granted` /
`updated` / `revoked`, `invitation.created` / `accepted` / `revoked`,
`api_key.created` / `revoked`, `agent.created` / `updated`,
`workspace.access_review.completed`, `workspace.audit_log.exported`,
`bank.statement.imported`, `bank.line.matched` / `added` / `excluded` /
`undone`, `bank.reconciliation.completed` / `undone`, `ar.credit.applied` /
`unapplied`, `ap.credit.applied` / `unapplied`, `ap.vendor_credit.*`,
`ap.vendor_refund.*`, `ap.checks.printed`, `ap.check.queued`,
`ap.purchase_order.submitted` / `approved` / `rejected` / `sent` /
`billed` / `closed` / `reopened`, `ap.recurring_bill.ran` / `failed` /
`paused` / `resumed`, `reports.exported`, `reports.1099.exported`, `gl.account.1099_box_set`,
`fiscal_period.soft_closed` / `hard_closed` / `reopened`, `fiscal_year.closed` /
`reopened`, `close_task.created` / `updated` / `completed` / `reopened`,
`company.closing_password_set` / `changed`, `gl.period.override_post`,
`sales_tax.rate.created` / `updated`, `sales_tax.payment.recorded`
/ `voided`, `settings.sales.updated`, `ar.estimate.invoiced` / `closed` /
`reopened`, `ar.recurring_invoice.ran` / `failed` / `paused` / `resumed`,
`settings.company_profile.updated`, `settings.company_logo.updated` /
`removed`, plus every bookkeeping change
(`ar.invoice.posted`, `gl.journal.drafted`, …).

## Platform settings to turn on

These live outside the code. Each one is cheap and auditors look for all
of them.

**Supabase**
- Point-in-time recovery (PITR) on the production project, and a restore
  test at least once a year
- MFA on every Supabase dashboard account; least privilege for org members
- Auth: enable TOTP MFA; minimum password length 10; leaked password
  protection (Pro plan); use asymmetric JWT signing keys; custom SMTP for
  password-reset emails from your domain
- Auth: "Confirm email" is off so new accounts get in at once. The trade:
  sign-up doesn't prove the inbox. Invitations still do (the link goes to
  that inbox), and a reset link to the real inbox takes an address back and
  signs out everyone else. Turn it on if you'd rather verify up front
- Network restrictions on the database; SSL enforced
- Apply all migrations (0022 adds the tenant guards, 0023 support access)

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
