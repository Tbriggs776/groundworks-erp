---
document: Information Security Policy
owner: Floor Daddy, LLC (d/b/a Groundworks)
version: 1.0
effective_date: 2026-11-01
next_review: 2027-11-01
approved_by: Tyler Briggs, Managing Member
---

# Information Security Policy

## 1. Purpose

This Information Security Policy ("Policy") establishes the principles,
responsibilities, and controls that Floor Daddy, LLC, an Arizona limited
liability company doing business as Groundworks ("Groundworks," "we," "us,"
or "our"), uses to protect the confidentiality, integrity, and
availability of the information systems and customer data within the
Groundworks Service (the "Service").

## 2. Scope

This Policy applies to:

- All personnel of Groundworks (owners, members, employees, contractors,
  and interns).
- All information systems that store, process, or transmit customer data,
  including the production application hosted on Vercel, the Supabase
  Postgres database, the Supabase object storage, and all development
  and staging environments.
- All third-party services (subprocessors) that process customer data
  under written agreement with Groundworks.
- All customer data, including data imported from Intuit QuickBooks
  Online, Plaid, and any other integration a customer enables.

## 3. Governance and roles

**Policy owner.** The Managing Member of Floor Daddy, LLC, is the owner
of this Policy and the ultimate authority for information security at
Groundworks.

**Security responsibility.** All engineering personnel at Groundworks
are jointly responsible for operating the controls described in this
Policy as part of their normal duties. Security is not treated as a
separate team; it is a standing responsibility across the engineering
function.

**Policy review.** This Policy is reviewed at least annually, and
whenever a material change to the Service, infrastructure, or
regulatory environment warrants an earlier review. Changes are
tracked in the project's version control system (`docs/compliance/`
in the Groundworks repository).

## 4. Risk management

Groundworks maintains a continuous view of security risk through:

- A SOC 2 control map maintained in-repo
  (`docs/compliance/soc2.md`) that enumerates the Common Criteria
  controls applicable to the Service.
- Automated tests that fail continuous integration if a tenant
  isolation or row-level security control is removed or weakened
  (`scripts/test-isolation.ts`, `scripts/test-rls.ts`).
- Automated dependency monitoring through Dependabot, with pull
  requests opened against the repository for every security
  advisory affecting a pinned dependency.
- Review of each pull request by a code owner before merge, per the
  repository's `CODEOWNERS` configuration.

Risks that cannot be remediated immediately are documented and
tracked to resolution. The repository's issue tracker is used as
the risk register.

## 5. Access control

**Principle of least privilege.** Personnel are granted the minimum
access required to perform their duties. Access to production is
limited to the owner and to engineering personnel actively working
on the Service.

**Multi-tenant isolation.** The Service is a multi-tenant application.
Isolation is enforced in depth:

- Every service function in the application layer filters by the
  authenticated actor's organization id and does not accept an
  organization id from the caller.
- Postgres row-level security is enabled on every tenant table,
  with a member-only `SELECT` policy. A CI test
  (`scripts/test-rls.ts`) fails if any table ships without an RLS
  policy.
- Database-level tenant-guard triggers reject any attempt to
  reference another organization's row and any attempt to change
  the `organization_id` of an existing row.
- A CI test (`scripts/test-isolation.ts`) attempts to execute every
  registered operation from a second workspace against the first
  workspace's data; the test fails if any operation returns a row,
  mutates data, or avoids the tenant guard.

**Workspace and company roles.** Customer access is a two-level model:
workspace membership (owner, admin, member) and per-company
membership (owner, admin, bookkeeper, accountant, viewer). Removing
a workspace seat terminates all company access and revokes personal
API keys issued by that user.

**Programmatic access.** API keys are prefixed `gwk_` and stored only
as SHA-256 digests; the plaintext value is shown once at creation.
Each key carries scopes and, for posting access, a per-key limit
enforced server-side.

**Support access.** Access by Groundworks support personnel to a
workspace is a time-bounded, read-only grant initiated by the
workspace owner. Each support visit is recorded in the audit log.

## 6. Authentication

**Identity provider.** User authentication is handled by Supabase Auth
using email and password.

**Password policy.** Password creation is governed by a documented
policy that enforces a minimum length and prohibits known-breached
passwords.

**Multi-factor authentication.** TOTP-based multi-factor
authentication is available to every user. A workspace may require
multi-factor authentication of all of its members; when a user
belongs to multiple workspaces, the strictest policy wins.

**Session policy.** Every authenticated request re-validates the
Supabase session claims and enforces:

- Idle timeout, per workspace policy.
- Maximum session age, per workspace policy.
- Revocation of specific sessions (device sign-out).
- The active-workspace and active-company cookies on every request.

**Agents.** Software agents authenticate using API keys. Agents
cannot act at the workspace level and cannot perform workspace
administration functions.

## 7. Cryptography

**In transit.** All traffic between clients and the Service, between
the Service and the database, and between the Service and
third-party APIs is encrypted using TLS 1.2 or higher.

**At rest.** Customer data at rest in the Supabase Postgres database
is encrypted by the managed service provider. Application-level
secrets that must be read back by the Service, including Intuit
QuickBooks OAuth tokens, Plaid access tokens, and API-key material
where applicable, are additionally sealed with AES-256-GCM under an
application-held key (`APP_ENCRYPTION_KEY`) stored only in the
deployment platform's secret store (Vercel environment variables,
marked Sensitive).

**OAuth state and signed URLs.** Short-lived values that cross the
browser, such as OAuth 2.0 `state` parameters, are signed with
HMAC-SHA256 using a key derived from the application encryption
key and are bound to a nonce stored in a short-lived, `httpOnly`
cookie.

**Key management.** Encryption keys are generated using a
cryptographically secure random source, stored in Vercel
environment variables marked Sensitive, and never written to the
code repository, chat tools, or logs. Key rotation is a planned,
scripted event; the operational key is not rotated on an ad hoc
basis.

## 8. Secure software development

**Version control.** All production code is maintained in a private
Git repository hosted on GitHub.

**Code review.** Every change to the production code base is reviewed
through a pull request before merge, per the repository's
`CODEOWNERS` configuration.

**Automated testing.** The repository includes end-to-end test
suites that exercise domain functionality, access controls, tenant
isolation, and row-level security. CI runs type checks, lint, build,
and the e2e suite on every pull request.

**Static analysis.** TypeScript strict mode is enabled, and ESLint
is enforced in CI. Server actions and server-only files are
protected by ESLint rules that prevent accidental exposure of
server internals to the client bundle.

**Secrets management.** Production secrets are stored only in the
Vercel environment variables of the production project, with
Sensitive flag enabled on each. Secrets are never committed to the
repository. Local development uses a `.env.local` file that is
ignored by Git.

**Dependency management.** Dependabot opens pull requests against
the repository for every security advisory affecting a pinned
dependency. Security-related updates are prioritized.

## 9. Vendor management (subprocessors)

Groundworks engages a limited set of vendors (subprocessors) that
process customer data on our behalf under written agreements
restricting their use of the data to providing services to us. The
current subprocessor list is:

| Subprocessor | Function | Location |
|---|---|---|
| Vercel Inc. | Application hosting and content delivery | United States |
| Supabase, Inc. | Managed Postgres, authentication, object storage | United States |
| Resend, Inc. | Transactional and document email delivery | United States |
| Plaid Inc. | Bank account linking and transaction retrieval | United States |
| Intuit Inc. | QuickBooks Online integration | United States |
| Anthropic PBC | AI reading of user-uploaded receipt images | United States |

The subprocessor list is reproduced in the public Privacy Policy
at `/legal/privacy`. Changes are tracked through the repository's
version control and reflected in the Privacy Policy when they
become effective.

Each prospective subprocessor is assessed for:

- Published security practices (SOC 2 Type II, ISO 27001, or
  equivalent, where available).
- Scope of data processed and whether that scope is minimized.
- Data residency and sub-sub-processing arrangements.
- Published data processing addendum terms.

## 10. Vulnerability management

**Monitoring.** Dependabot monitors first-party and transitive
dependencies for published advisories. Vercel's platform-level
runtime provides base-image patching and TLS certificate renewal.

**Response.** Vulnerabilities are triaged by severity:

- Critical and High advisories affecting production dependencies
  are addressed as soon as a fix is available, typically within
  seven days.
- Medium advisories are addressed within thirty days.
- Low advisories are tracked and addressed opportunistically.

**Penetration testing.** Groundworks is pre-revenue and currently
operates automated isolation testing as its primary attack-surface
exercise. Third-party penetration testing will be commissioned
before onboarding customers whose contract requires it.

## 11. Logging and audit

**Audit log.** Every mutation performed by the Service writes an
append-only row to the `audit_log` table that records:

- The actor (user, agent, or system) and the actor's role.
- The channel (web, REST API, MCP server).
- The workspace and company context, where applicable.
- The request identifier, IP address, and user agent.
- The event type and entity.
- A structured metadata object.

Audit log rows are append-only; the schema does not allow updates
or deletes.

**Workspace scope.** Workspace-level events, such as member
additions, security policy changes, and support-access grants, are
recorded on the same audit log with the workspace id populated.

**Runtime logs.** Server execution traces are captured by Vercel's
runtime log system with 30-day retention. Fatal errors are
surfaced in the Vercel dashboard.

**Access to logs.** Logs are available to the owner through the
Vercel dashboard and to the signed-in user through the Audit page
inside Groundworks (scoped to the workspace or company they have
access to).

## 12. Data retention and deletion

The authoritative retention schedule, disposal methods, legal-hold
procedure, and backup-restoration procedure are set out in the Data
Retention and Disposal Policy
(`docs/compliance/data-retention-policy.md`), which is a companion to
this Policy and is published publicly at `/legal/retention`. The
summary below is for orientation; the companion policy controls where
the two differ.

**Operational retention.** Customer data is retained for the duration
of the customer's active account, plus a reasonable period thereafter
to meet legal, dispute-resolution, and backup-cycle obligations.
Financial records are retained for the life of the company plus seven
years.

**Audit log retention.** Audit log entries are retained for the
longer of seven years and the period required by applicable law.

**Deletion requests.** Customers may request deletion of their data
by contacting the published privacy address
(`tyler@tylermbriggs.com`). On a verified request, we delete or
return the account's data within sixty (60) days, subject to legal
holds and routine encrypted backup cycles.

**Backup rotation.** Database backups cycle on the managed provider's
default schedule and age out according to that schedule.

## 13. Incident response

**Definition.** An incident is any confirmed or suspected event that
compromises the confidentiality, integrity, or availability of
customer data or the Service.

**Reporting.** Personnel who identify a potential incident report it
immediately to the Managing Member. External reports are accepted
at `tyler@tylermbriggs.com`.

**Response steps.**

1. **Contain.** Stop ongoing loss by rotating credentials, revoking
   sessions, blocking access paths, or taking affected components
   offline as needed.
2. **Assess.** Determine the scope, categories of data involved,
   and affected customers.
3. **Eradicate.** Remove the root cause (patch, misconfiguration
   fix, revoked key, etc.).
4. **Recover.** Return the Service to normal operation with
   validated controls.
5. **Notify.** Notify affected customers and regulators as required
   by law and contract, within the time frames those sources
   require.
6. **Learn.** Perform a written post-incident review within thirty
   days of resolution and update this Policy and the SOC 2 control
   map as warranted.

**Breach notification.** Floor Daddy, LLC complies with notification
obligations under Arizona Revised Statutes 18-552 and all other
applicable breach notification statutes, including notifications
to customers whose data is affected and to the Arizona Attorney
General where required.

## 14. Business continuity

**Hosting.** The Service runs on Vercel, which provides highly
available hosting with automated failover across regions.

**Data.** Customer data is stored in Supabase, which maintains
automated backups with point-in-time recovery over the retention
window of the active plan.

**Recovery objectives.** Groundworks targets a recovery time
objective (RTO) of four hours and a recovery point objective (RPO)
of twenty-four hours for the Service and its primary database.
These targets are revisited as the customer base grows.

**Documentation.** Operational runbooks for recovery scenarios are
maintained in the repository.

## 15. Secure configuration

**Network security.** The Service does not expose a public database
endpoint; the database is reached only from the Vercel runtime
over TLS. Outbound requests to third-party APIs use TLS and
pinned endpoints where published.

**Security headers.** The Service sets a per-request Content Security
Policy with a per-request nonce, HTTP Strict Transport Security,
frame denial, and nosniff on all responses. Inline scripts are
not permitted. These headers are set in the Vercel edge
(`src/proxy.ts`, `next.config.ts`, and
`src/lib/security/headers.ts`).

**Rate limiting.** Supabase Auth rate limits sign-in attempts; the
Service applies per-key rate limits on API calls.

**Browser isolation.** The Service runs third-party Plaid Link
iframes only on the `/banking/feeds` path, under a scoped
Content Security Policy.

## 16. Training and acceptable use

**Personnel acknowledgment.** All personnel acknowledge this Policy
as a condition of access to Groundworks systems.

**Acceptable use.** Personnel may not share credentials, store
production secrets outside the approved secret store, or
exfiltrate customer data for personal or external use.

## 17. Compliance

Groundworks maintains a SOC 2 control map in
`docs/compliance/soc2.md`. The Service is designed to support SOC 2
Type II attestation. Formal attestation will be commissioned at
the customer-growth milestone that warrants it.

## 18. Exceptions

Any exception to this Policy must be documented, approved by the
Managing Member in writing, and reviewed on at least a quarterly
basis for retirement.

## 19. Enforcement

Violation of this Policy may result in disciplinary action, up to
and including termination of employment or contract, and, where
applicable, civil or criminal referral.

## 20. Contact

Policy questions, reports of suspected incidents, and compliance
inquiries may be directed to:

> Floor Daddy, LLC
>
> Attn: Information Security
>
> 22495 E Russet Rd
>
> Queen Creek, Arizona 85142
>
> Email: tyler@tylermbriggs.com

---

**Document history**

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1.0 | 2026-11-01 | Initial issue | Tyler Briggs, Managing Member |
