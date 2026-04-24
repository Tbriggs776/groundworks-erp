import { pgEnum, timestamp } from "drizzle-orm/pg-core";

/**
 * Standard timestamps. Spread into every table.
 *   `deletedAt` enables soft-delete. Queries should filter `WHERE deleted_at IS NULL`
 *   unless they explicitly need tombstoned rows (audit / compliance).
 */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

// ---------------------------------------------------------------------------
// Identity / membership
// ---------------------------------------------------------------------------

/**
 * Organization-level role. Drives authorization throughout the app.
 *   owner       — full control, billing, can delete the org
 *   admin       — full app access, no billing
 *   accountant  — GL / AP / AR / close
 *   pm          — project/job management, no posting to GL
 *   foreman     — field ops (time, daily reports), read-only on financials
 *   viewer      — read-only
 * Roles are intentionally coarse at this layer; fine-grained permissions live
 * in a separate `permissions` layer later.
 */
export const membershipRole = pgEnum("membership_role", [
  "owner",
  "admin",
  "accountant",
  "pm",
  "foreman",
  "viewer",
]);

// Role comparison is done in app code via RoleRank — see src/lib/auth.ts.
// Keep the order of this enum aligned with the rank function.

// ---------------------------------------------------------------------------
// Chart of Accounts
// ---------------------------------------------------------------------------

/**
 * Account type (BC model). Controls whether the row is a posting target or a
 * structural element of the CoA.
 *   posting      — leaf account, receives journal lines
 *   heading      — display-only heading, no posting, no totaling
 *   total        — computed total over a range (see `totaling` column)
 *   begin_total  — opens a range for a later end_total
 *   end_total    — closes a range opened by begin_total; typically paired
 */
export const accountType = pgEnum("account_type", [
  "posting",
  "heading",
  "total",
  "begin_total",
  "end_total",
]);

/** High-level financial statement bucket. */
export const accountCategory = pgEnum("account_category", [
  "balance_sheet",
  "income_statement",
]);

/**
 * Full subcategory taxonomy — drives default normal balance and financial
 * statement ordering. 25 values covering mid-market contractor needs.
 */
export const accountSubcategory = pgEnum("account_subcategory", [
  // Assets
  "cash",
  "receivables",
  "inventory",
  "other_current_asset",
  "fixed_assets",
  "other_asset",
  // Liabilities
  "payables",
  "accrued_liabilities",
  "other_current_liability",
  "lt_debt",
  "other_liability",
  // Equity
  "equity",
  "retained_earnings",
  // Revenue
  "operating_revenue",
  "other_revenue",
  // Cost of goods (construction COGS breakdown)
  "cogs_labor",
  "cogs_materials",
  "cogs_equipment",
  "cogs_subcontractor",
  "cogs_other",
  // Expenses
  "operating_expense",
  "sga",
  "interest",
  "tax",
  "other_expense",
]);

export const normalBalance = pgEnum("normal_balance", ["debit", "credit"]);

export const debitCreditEnforced = pgEnum("debit_credit_enforced", [
  "debit_only",
  "credit_only",
  "either",
]);

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * How strictly a dimension must be present on a journal line posting to an
 * account. BC's pattern.
 *   no_code                      — dimension may not be populated
 *   code_mandatory               — dimension value required
 *   same_code                    — value required and must equal the default
 *   same_code_and_same_value     — same as same_code but value must also match
 *                                  default's value (rare, for rigid mappings)
 */
export const dimensionValuePosting = pgEnum("dimension_value_posting", [
  "no_code",
  "code_mandatory",
  "same_code",
  "same_code_and_same_value",
]);

export const combinationStatus = pgEnum("combination_status", [
  "allowed",
  "blocked",
]);

// ---------------------------------------------------------------------------
// Fiscal calendar + posting control
// ---------------------------------------------------------------------------

export const fiscalYearStatus = pgEnum("fiscal_year_status", [
  "open",
  "closed",
]);

/**
 * Period status state machine:
 *   open        — any authorized user can post
 *   soft_closed — only source=adjusting | reversing accepted
 *   hard_closed — no posting without the org hard-close override password
 */
export const periodStatus = pgEnum("period_status", [
  "open",
  "soft_closed",
  "hard_closed",
]);

// ---------------------------------------------------------------------------
// Currency / FX
// ---------------------------------------------------------------------------

/**
 * Exchange rate types. Each serves a different reporting purpose:
 *   spot           — point-in-time rate used for transactional posting
 *   average        — period-average rate used for P&L translation
 *   historical     — locked rate for equity / historical balances
 *   budget         — rate for budget translation (fixed per plan)
 *   consolidation  — parent-co rate for consolidation reporting
 */
export const exchangeRateType = pgEnum("exchange_rate_type", [
  "spot",
  "average",
  "historical",
  "budget",
  "consolidation",
]);

// ---------------------------------------------------------------------------
// Journals & posting
// ---------------------------------------------------------------------------

/**
 * Where a journal came from. Drives which source_codes / templates apply,
 * which period-status exceptions are allowed, and which subledger holds the
 * originating document.
 */
export const journalSource = pgEnum("journal_source", [
  "manual",
  "ap",
  "ar",
  "cash_receipt",
  "cash_disbursement",
  "payroll",
  "inventory",
  "fixed_asset",
  "ic",
  "recurring",
  "reversing",
  "adjusting",
  "year_end_close",
]);

/**
 * Journal lifecycle.
 *   draft             — being built, not yet posted
 *   pending_approval  — awaiting an approver (if approval workflow enabled)
 *   posted            — committed to the ledger, immutable
 *   reversed          — has been reversed by another journal
 */
export const journalStatus = pgEnum("journal_status", [
  "draft",
  "pending_approval",
  "posted",
  "reversed",
]);

/**
 * Batch lifecycle. Batches group multiple journals for a single post run.
 *   open      — journals being staged
 *   posting   — post run in flight (prevents concurrent posts)
 *   posted    — all journals in batch successfully posted
 *   error     — at least one journal failed; batch halted mid-post
 */
export const batchStatus = pgEnum("batch_status", [
  "open",
  "posting",
  "posted",
  "error",
]);

/**
 * Type of the balancing account on a journal template. Determines how the
 * subledger link on that side of the entry is interpreted.
 *   gl            — balancing account is a plain GL account
 *   bank          — bank account (links to bank master)
 *   customer      — AR customer (subledger)
 *   vendor        — AP vendor (subledger)
 *   fixed_asset   — fixed asset (subledger)
 *   ic_partner    — intercompany partner (for IC journals)
 */
export const balAccountType = pgEnum("bal_account_type", [
  "gl",
  "bank",
  "customer",
  "vendor",
  "fixed_asset",
  "ic_partner",
]);

// ---------------------------------------------------------------------------
// Recurring / allocation / budget
// ---------------------------------------------------------------------------

/**
 * Recurring-journal cadence. `frequency_day` on the recurring row interprets
 * monthly/quarterly/etc. as day-of-month; weekly/biweekly uses a weekday idx.
 */
export const recurringFrequency = pgEnum("recurring_frequency", [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "semiannually",
  "annually",
]);

/**
 * Recurring lifecycle.
 *   active — scheduler generates a JE on each next_run_date
 *   paused — still live, no generation until resumed
 *   ended  — terminal; end_date reached or manually ended
 */
export const recurringStatus = pgEnum("recurring_status", [
  "active",
  "paused",
  "ended",
]);

/**
 * Allocation driver type.
 *   fixed       — static percentages on allocation_targets
 *   statistical — percentages derived from a statistical account's
 *                 dimension-bucketed balance (e.g., allocate rent by
 *                 square footage recorded in a `SQFT` statistical acct)
 */
export const allocationType = pgEnum("allocation_type", [
  "fixed",
  "statistical",
]);

// ---------------------------------------------------------------------------
// Projects / Jobs / Cost Codes
// ---------------------------------------------------------------------------

/**
 * Cost code classification — drives reporting (e.g., "Labor burden as % of
 * labor cost") and default GL mapping when AP bills or time entries post to
 * a cost code.
 *   overhead — indirect construction cost, not tied to a single job
 *   statistical — non-monetary (hours, sqft) for allocation or KPIs
 */
export const costType = pgEnum("cost_type", [
  "labor",
  "material",
  "equipment",
  "subcontractor",
  "other",
  "overhead",
  "statistical",
]);

/**
 * Job state machine. Transitions are strict (enforced in server actions):
 *   bid → awarded | closed
 *   awarded → active | closed
 *   active → on_hold | closed
 *   on_hold → active | closed
 *   closed → (terminal; reopen requires admin + audit)
 */
export const jobStatus = pgEnum("job_status", [
  "bid",
  "awarded",
  "active",
  "on_hold",
  "closed",
]);

// ---------------------------------------------------------------------------
// AP (Accounts Payable)
// ---------------------------------------------------------------------------

/**
 * AP bill lifecycle:
 *   draft — being built
 *   pending_approval — submitted, awaiting a qualified approver
 *   rejected — approver kicked it back; moves back to draft (with reason)
 *   approved — approver signed off; ready to post
 *   posted — GL journal created; vendor now owed
 *   paid — fully paid via one or more payment applications (2.2b)
 *   voided — reversed via a reversing GL journal
 */
export const apBillStatus = pgEnum("ap_bill_status", [
  "draft",
  "pending_approval",
  "rejected",
  "approved",
  "posted",
  "paid",
  "voided",
]);

/**
 * What an approval threshold applies to. Starts with `ap_bill`; future
 * domains (manual JE, AP payment, job change order over X) slot in here
 * without a breaking migration.
 */
export const approvalScope = pgEnum("approval_scope", ["ap_bill"]);
