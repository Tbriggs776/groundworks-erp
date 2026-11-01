---
document: Data Retention and Disposal Policy
owner: Floor Daddy, LLC (d/b/a Groundworks)
version: 1.0
effective_date: 2026-11-01
next_review: 2027-11-01
approved_by: Tyler Briggs, Managing Member
---

# Data Retention and Disposal Policy

## 1. Purpose

This Data Retention and Disposal Policy ("Policy") sets out how long
Floor Daddy, LLC, an Arizona limited liability company doing business as
Groundworks ("Groundworks," "we," "us," or "our"), retains customer data
and other categories of information processed in connection with the
Groundworks Service (the "Service"), and the methods we use to dispose of
that information at the end of its retention period. This Policy
elaborates Section 12 of the Information Security Policy
(`docs/compliance/information-security-policy.md`) and is cross-referenced
in the SOC 2 control map (`docs/compliance/soc2.md`).

## 2. Scope

This Policy applies to:

- All personnel of Groundworks (owners, members, employees, contractors,
  and interns).
- All information systems that store, process, or transmit customer data,
  including the production application hosted on Vercel, the Supabase
  Postgres database, Supabase Auth, Supabase object storage, and the
  managed services of our subprocessors.
- All customer data, including data imported from Intuit QuickBooks
  Online, bank activity retrieved through Plaid, and documents and
  attachments uploaded by customers.
- All operational records that reference customer data, including
  application logs, audit trail entries, and database backups.

## 3. Governance

**Policy owner.** The Managing Member of Floor Daddy, LLC, is the owner
of this Policy.

**Policy review.** This Policy is reviewed at least annually, and
whenever a material change to the Service, our subprocessors, or
applicable law warrants an earlier review. Changes are tracked in the
project's version control system (`docs/compliance/` in the Groundworks
repository) and recorded in the document history at the end of this
Policy.

**Legal basis.** Retention periods reflect, in combination: our
contractual obligation to maintain the customer's books while their
account is active; the customer's obligation to retain supporting
business records under the Internal Revenue Code and applicable state
tax statutes; the Arizona statute of limitations on contract and tort
claims; our own need to investigate security incidents and support
disputes; and the operational need to recover from failures.

## 4. Retention schedule

The following schedule sets the authoritative retention periods for
every category of information Groundworks processes. "End of retention"
means the point at which the record becomes eligible for disposal
through the methods described in Section 6.

| Category | Retention period | Trigger | Legal or operational basis |
|---|---|---|---|
| Account identity (name, email, password hash) | Life of account + 90 days | Account closure | Contract performance; security |
| Workspace and company configuration (names, fiscal year, chart of accounts, settings) | Life of workspace + 60 days | Workspace or company deletion request | Contract performance |
| Workspace and company membership records | Life of workspace + 7 years | Workspace deletion | Access-review support; tax records |
| Financial records (general ledger journals, invoices, bills, payments, estimates, purchase orders, change orders, bank activity, reconciliations) | Life of company + 7 years | Company deletion request | IRC §6001; A.R.S. §42-1104; audit support |
| Attachments and uploaded documents (contracts, receipts, lien waivers, statements) | Life of company + 7 years | Company deletion request | Statute of limitations; audit support |
| Audit log entries (append-only) | Longer of 7 years and the period required by applicable law | Workspace deletion | Accounting integrity; SOC 2 control CC7.2 |
| QuickBooks Online OAuth tokens | Until the customer disconnects the integration | Disconnection or account closure | Minimum necessary; data minimization |
| Plaid access tokens | Until the customer disconnects the bank, or 24 months rolling, whichever is shorter | Disconnection or token age | Plaid platform requirement; data minimization |
| Plaid-returned transactions | Life of company + 7 years, same as financial records | Company deletion request | Accounting integrity; audit support |
| Email delivery and engagement events (Resend) | 30 days inside Resend; event metadata written to the audit log retained per audit log policy | Age | Deliverability support |
| Short-lived security values (OAuth state, nonce cookies, signed URL grants) | Minutes to hours per value; expired on first use or on timeout | Age | Security; replay protection |
| Session records (`user_sessions`) | 90 days after revocation or last activity, whichever is later | Age | Session management; auditability |
| API keys (`api_keys` row with SHA-256 digest) | Until revoked; metadata retained in the audit log per audit log policy | Revocation | Access control; investigation support |
| Application runtime logs (Vercel) | 30 days in Vercel; longer in a drained log store if configured | Age | Debugging; incident response |
| Database backups (Supabase, including point-in-time recovery window) | Managed by Supabase per the active plan; typically 7–35 days of PITR plus daily snapshots | Age | Disaster recovery |
| Support communications (email to and from `tyler@tylermbriggs.com`) | 7 years | Age | Dispute resolution; service history |
| Marketing contacts (prospective customers) | Until opt-out, plus 30 days to process the opt-out | Opt-out request | Legitimate interest; CAN-SPAM |

Statutory financial-record retention is grounded in Internal Revenue
Code §6001 and in Arizona Revised Statutes §42-1104, which require
business records supporting a tax return to be kept for at least the
period of limitations for that return (generally three to seven years;
longer in cases of substantial understatement or fraud). Groundworks
defaults to seven years to cover the longer window and to align with
other jurisdictions a customer may operate in.

Audit log retention follows the longer-of rule because the audit log is
the evidence base for both SOC 2 (CC7.2) and the customer's own
accounting review.

## 5. Deletion and portability requests

**Who may request.** A workspace owner may request deletion of the
workspace or of any of its companies. An individual user may request
deletion of their personal account.

**How to request.** Requests are submitted by email to the published
privacy address, `tyler@tylermbriggs.com`. We acknowledge within three
business days and complete verified requests within sixty (60) days,
subject to the exceptions below. We will provide a machine-readable
export (CSV or JSON) of the account's data before deletion if the
requester asks for one.

**Verification.** Before acting on a deletion or export request, we
verify the requester's control of the account by requiring a response
from the account's registered email address, and, for workspace-wide
requests, from the workspace owner on record.

**Exceptions.** We may continue to retain, in restricted-access form,
information we are required to retain to:

- Meet a records-retention obligation imposed by law, including the
  tax-record and audit-trail obligations in Section 4.
- Comply with a legal hold described in Section 8.
- Resolve an open dispute or complete a billing cycle.
- Allow routine encrypted database backups to age out of the backup
  cycle described in Section 4; records inside those backups are not
  separately deleted on request but become unreachable as backups
  expire.

We state the applicable exception when we rely on it.

**Statutory rights.** We honor the data-subject rights of residents of
California (CCPA/CPRA), Virginia (VCDPA), Colorado (CPA), Connecticut
(CTDPA), Utah (UCPA), and other U.S. states to the extent those laws
apply to us, and the data-subject rights under the EU and UK General
Data Protection Regulations where applicable.

## 6. Disposal methods

Disposal is matched to the storage medium:

| Medium | Method |
|---|---|
| Managed Postgres (customer data) | Hard `DELETE` executed inside a database transaction. Soft-deleted rows (`deleted_at IS NOT NULL`) are hard-deleted after a 90-day grace window. The managed-database provider reclaims the underlying storage on its standard schedule. |
| Managed Postgres (audit log) | No deletion. Entries become eligible to be archived to cold storage after the retention period in Section 4, but are never updated or removed; the schema enforces append-only semantics through a database trigger. |
| Supabase Auth records | Supabase account deletion through the Admin API, which removes the authentication row, enrolled MFA factors, and session records. |
| Supabase object storage | `DELETE` via the Storage API, confirmed by the API response. File digests remain in the audit log. |
| Secrets (API keys, OAuth tokens, Plaid tokens) | Revocation at the issuing provider (Intuit, Plaid, Supabase) followed by removal of the encrypted token row. The SHA-256 digest of a revoked API key remains in the audit log. |
| Database backups | Natural expiry on the managed-database provider's backup schedule; we do not reach into backups to selectively redact. |
| Runtime logs (Vercel) | Natural expiry at 30 days inside Vercel. If a log drain is configured, the drained store's retention controls apply. |
| Printed records | Shredding to a cross-cut standard. Groundworks does not routinely print customer records; this provision applies to any ad hoc printout. |

Where a vendor performs the disposal (Supabase for backups, Vercel for
runtime logs, Resend for delivery logs, Intuit for revoked tokens),
we rely on the vendor's documented practices and on the records of the
revocation or deletion call we made.

## 7. Backup restoration

Information restored from backup may re-materialize records that were
previously deleted. After any restore from backup, the Managing Member
re-applies outstanding deletion requests against the restored
environment within seven days and records the re-application in the
audit log and in the incident record if the restore was prompted by an
incident.

## 8. Legal hold

A legal hold suspends the Section 4 and Section 5 deletion requirements
for specified data when preservation is required by litigation, a
subpoena or court order, a regulatory inquiry, or a cooperative
agreement with law enforcement. A legal hold is:

- Documented in writing, with scope, basis, custodian list, and
  expected duration.
- Applied with the narrowest scope that satisfies the obligation.
- Reviewed at least quarterly for continued necessity.
- Lifted promptly when no longer required, with the affected records
  returning to the Section 4 schedule.

Legal holds are approved by the Managing Member and recorded in the
compliance folder of the Groundworks repository.

## 9. Enforcement

Violation of this Policy by Groundworks personnel is grounds for
disciplinary action, up to and including termination of employment or
contract, and, where applicable, civil or criminal referral.

## 10. Contact

Questions about this Policy and data-subject requests may be directed
to:

> Floor Daddy, LLC
>
> Attn: Privacy
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
