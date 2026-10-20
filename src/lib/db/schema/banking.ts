import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  bankRuleDirection,
  bankTxnStatus,
  bankTxnType,
  clearingStatus,
  paymentMethod,
  reconciliationStatus,
  statementFormat,
  statementLineStatus,
  timestamps,
} from "./_shared";
import { accounts } from "./accounts";
import { agents } from "./agents";
import { arPayments, type DimensionTag } from "./ar";
import { organizations, profiles } from "./identity";
import { glJournals, glLines } from "./journals";
import { customers, vendors } from "./parties";
import { salesReceipts } from "./sales";

/**
 * BANKING — money moving through bank and credit card accounts that isn't
 * a bill payment or a customer payment, plus statement import, the "For
 * review" list, bank rules, and reconciliation.
 *
 * Banking accounts are posting accounts flagged `isReconciliation`
 * (Checking, Savings, Credit Card in the default chart) or `isCash`.
 *
 * Sign convention, everywhere in this file: amounts on the bank side are
 * from the account holder's view. Positive = money in (a deposit; on a
 * credit card, a payment or refund), negative = money out (a withdrawal;
 * on a card, a charge). That equals debit − credit on the account.
 */

// ---------------------------------------------------------------------------
// Bank transactions (Expense / Check / Deposit / Transfer)
// ---------------------------------------------------------------------------

/**
 * Posting:
 *   expense / check  Dr each line's account / Cr bank account (total)
 *   deposit          Dr bank account (total) / Cr each line's account
 *                    (a line carrying ar_payment_id credits Undeposited
 *                    Funds: it moves a received payment into the bank)
 *   transfer         Dr transfer_account / Cr bank_account (total)
 * A negative line flips its side (a refund line on an expense).
 */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    txnNumber: text("txn_number").notNull(),
    type: bankTxnType("type").notNull(),
    txnDate: date("txn_date").notNull(),

    /** The bank / card account money leaves (expense, check, transfer) or lands in (deposit). */
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** Transfers only: the other bank / card account. */
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id, {
      onDelete: "restrict",
    }),

    /** Payee / payer: a vendor, a customer, or just a name. */
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    payeeName: text("payee_name"),

    method: paymentMethod("method"),
    /** Check number, card reference, or confirmation. */
    reference: text("reference"),
    memo: text("memo"),

    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }).notNull().default("1"),
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 }).notNull(),

    status: bankTxnStatus("status").notNull().default("draft"),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => profiles.id, { onDelete: "set null" }),
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    voidGlJournalId: uuid("void_gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("bank_transactions_org_num_key").on(t.organizationId, t.txnNumber),
    index("bank_transactions_account_idx").on(t.organizationId, t.bankAccountId, t.txnDate),
    index("bank_transactions_status_idx").on(t.organizationId, t.status),
  ]
);

export const bankTransactionLines = pgTable(
  "bank_transaction_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => bankTransactions.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    /** Category account (expense, income, asset, liability, equity). */
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** Signed: a negative line flips debit / credit. */
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    description: text("description"),
    /** Who the line is for (billable expense, or a deposit's payer). */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    /** Deposits only: a received customer payment moved out of Undeposited Funds. */
    arPaymentId: uuid("ar_payment_id").references(() => arPayments.id, { onDelete: "restrict" }),
    /** Deposits only: a sales receipt moved out of Undeposited Funds. */
    salesReceiptId: uuid("sales_receipt_id").references(() => salesReceipts.id, { onDelete: "restrict" }),
    dimensions: jsonb("dimensions").$type<DimensionTag[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bank_transaction_lines_txn_line_key").on(t.transactionId, t.lineNumber),
    index("bank_transaction_lines_payment_idx").on(t.arPaymentId),
    index("bank_transaction_lines_receipt_idx").on(t.salesReceiptId),
  ]
);

// ---------------------------------------------------------------------------
// Statement import + For review
// ---------------------------------------------------------------------------

export const bankStatementImports = pgTable(
  "bank_statement_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    fileName: text("file_name"),
    format: statementFormat("format").notNull(),
    lineCount: integer("line_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    startDate: date("start_date"),
    endDate: date("end_date"),
    /** The bank's ending balance, when the file says (OFX LEDGERBAL). */
    ledgerBalance: numeric("ledger_balance", { precision: 20, scale: 4 }),
    ledgerBalanceDate: date("ledger_balance_date"),
    importedBy: uuid("imported_by").references(() => profiles.id, { onDelete: "set null" }),
    importedByAgentId: uuid("imported_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bank_statement_imports_account_idx").on(t.organizationId, t.accountId, t.createdAt)]
);

/**
 * One line from a bank statement. `fit_id` is the bank's transaction id
 * (OFX FITID) or, for CSV, a hash of the line; it's unique per account, so
 * importing overlapping files never duplicates a line.
 */
export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    importId: uuid("import_id")
      .notNull()
      .references(() => bankStatementImports.id, { onDelete: "cascade" }),
    postedDate: date("posted_date").notNull(),
    /** Signed, account holder's view: + money in, − money out. */
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    description: text("description").notNull(),
    payee: text("payee"),
    reference: text("reference"),
    fitId: text("fit_id").notNull(),
    status: statementLineStatus("status").notNull().default("for_review"),
    /** Set when "added": the bank transaction created from this line. */
    bankTransactionId: uuid("bank_transaction_id").references(() => bankTransactions.id, {
      onDelete: "set null",
    }),
    /** The rule that categorized it, if any. */
    ruleId: uuid("rule_id").references(() => bankRules.id, { onDelete: "set null" }),
    reviewedBy: uuid("reviewed_by").references(() => profiles.id, { onDelete: "set null" }),
    reviewedByAgentId: uuid("reviewed_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bank_statement_lines_fit_key").on(t.accountId, t.fitId),
    index("bank_statement_lines_review_idx").on(t.organizationId, t.accountId, t.status, t.postedDate),
  ]
);

/** A statement line matched to ledger lines already in the books (one or more). */
export const bankStatementMatches = pgTable(
  "bank_statement_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    statementLineId: uuid("statement_line_id")
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: "cascade" }),
    glLineId: uuid("gl_line_id")
      .notNull()
      .references(() => glLines.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bank_statement_matches_gl_line_key").on(t.glLineId),
    index("bank_statement_matches_line_idx").on(t.statementLineId),
  ]
);

// ---------------------------------------------------------------------------
// Bank rules
// ---------------------------------------------------------------------------

export type BankRuleCondition = {
  field: "description" | "payee" | "amount";
  op: "contains" | "not_contains" | "equals" | "starts_with" | "greater_than" | "less_than";
  value: string;
};

/**
 * "When a line looks like this, categorize it like that." Lower priority
 * runs first; the first rule that matches wins. Amount conditions compare
 * the absolute amount. With `auto_add`, matching lines are added (posted)
 * at import without a person reviewing them.
 */
export const bankRules = pgTable(
  "bank_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    /** Only lines from this bank account; null = every account. */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    direction: bankRuleDirection("direction").notNull().default("any"),
    conditions: jsonb("conditions").$type<BankRuleCondition[]>().notNull().default([]),
    /** true = every condition must hold; false = any one. */
    matchAll: boolean("match_all").notNull().default(true),

    /** Action: categorize to this account… */
    categoryAccountId: uuid("category_account_id").references(() => accounts.id, {
      onDelete: "restrict",
    }),
    /** …or record it as a transfer with this bank / card account. */
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id, {
      onDelete: "restrict",
    }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    payeeName: text("payee_name"),
    memo: text("memo"),
    dimensions: jsonb("dimensions").$type<DimensionTag[]>().notNull().default([]),
    autoAdd: boolean("auto_add").notNull().default(false),

    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [index("bank_rules_org_idx").on(t.organizationId, t.priority)]
);

// ---------------------------------------------------------------------------
// Clearing + reconciliation
// ---------------------------------------------------------------------------

/**
 * Cleared / reconciled state for ledger lines on a bank or card account.
 * Kept beside the ledger because posted lines are immutable. A line with
 * no row here is uncleared.
 */
export const glLineClearings = pgTable(
  "gl_line_clearings",
  {
    glLineId: uuid("gl_line_id")
      .primaryKey()
      .references(() => glLines.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    status: clearingStatus("status").notNull().default("cleared"),
    /** Set once reconciled (and while ticked in an in-progress reconciliation). */
    reconciliationId: uuid("reconciliation_id").references(() => reconciliations.id, {
      onDelete: "set null",
    }),
    clearedBy: uuid("cleared_by").references(() => profiles.id, { onDelete: "set null" }),
    clearedByAgentId: uuid("cleared_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gl_line_clearings_account_idx").on(t.organizationId, t.accountId, t.status)]
);

/**
 * Reconcile an account to a statement: tick the ledger lines the
 * statement shows until cleared balance = statement ending balance, then
 * complete. Beginning balance = everything reconciled before. Only the
 * latest completed reconciliation can be undone.
 */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    statementEndDate: date("statement_end_date").notNull(),
    statementEndingBalance: numeric("statement_ending_balance", { precision: 20, scale: 4 }).notNull(),
    beginningBalance: numeric("beginning_balance", { precision: 20, scale: 4 }).notNull(),
    /** Snapshot at completion. */
    clearedBalance: numeric("cleared_balance", { precision: 20, scale: 4 }),
    clearedCount: integer("cleared_count"),
    status: reconciliationStatus("status").notNull().default("in_progress"),
    startedBy: uuid("started_by").references(() => profiles.id, { onDelete: "set null" }),
    startedByAgentId: uuid("started_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => profiles.id, { onDelete: "set null" }),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: uuid("undone_by").references(() => profiles.id, { onDelete: "set null" }),
    undoReason: text("undo_reason"),
    ...timestamps,
  },
  (t) => [
    index("reconciliations_account_idx").on(t.organizationId, t.accountId, t.statementEndDate),
    uniqueIndex("reconciliations_one_open_key")
      .on(t.accountId)
      .where(sql`status = 'in_progress'`),
  ]
);

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type BankTransactionLine = typeof bankTransactionLines.$inferSelect;
export type BankStatementImport = typeof bankStatementImports.$inferSelect;
export type BankStatementLine = typeof bankStatementLines.$inferSelect;
export type BankRule = typeof bankRules.$inferSelect;
export type GlLineClearing = typeof glLineClearings.$inferSelect;
export type Reconciliation = typeof reconciliations.$inferSelect;
