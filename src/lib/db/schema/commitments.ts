import { relations } from "drizzle-orm";
import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { commitmentStatus, commitmentType, timestamps } from "./_shared";
import { accounts } from "./accounts";
import { costCodes } from "./cost_codes";
import { organizations, profiles } from "./identity";
import { jobs } from "./projects";
import { vendors } from "./parties";

/**
 * COMMITMENTS — Purchase Orders + Subcontracts. The construction control
 * for "we promised vendor X up to $Y for cost code Z on job J". Bills
 * coming in optionally link to a commitment line, which moves money
 * from the committed bucket to the actual bucket on the job.
 *
 * Lifecycle (see commitment_status enum):
 *   draft → issued → closed | voided
 *
 * On `issued` (atomic):
 *   - For each line: job_cost_codes.committed_amount += line.amount
 *     (upsert — adds to existing budget row OR inserts a new one)
 *   - Lines lock against further editing
 *
 * On `closed` (atomic):
 *   - For each line: remaining = amount - invoiced_amount
 *     job_cost_codes.committed_amount -= remaining  (we accept we won't
 *     spend the rest; remaining un-invoiced commitment drops away)
 *   - No GL impact (the invoiced portion is already in actuals)
 *
 * On `voided` (atomic, admin only):
 *   - Same effect as close on committed_amount.
 *   - Future bills cannot link to this commitment's lines.
 *   - Bills already linked stay linked (audit history).
 *
 * Naming: per-org auto-numbered via the PO or SUB number series
 * depending on type. external_reference is the vendor's PO# or
 * contract number on their side.
 */
export const commitments = pgTable(
  "commitments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),

    commitmentNumber: text("commitment_number").notNull(), // PO-NNNNNN | SUB-NNNNNN
    externalReference: text("external_reference"),

    type: commitmentType("type").notNull().default("po"),
    status: commitmentStatus("status").notNull().default("draft"),

    description: text("description").notNull(),

    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 })
      .notNull()
      .default("1"),

    // Sum of all line amounts on this commitment. Maintained by
    // upsert / line-edit operations.
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    // Sum of bills posted against this commitment's lines.
    // Maintained by AP bill post/void.
    invoicedAmount: numeric("invoiced_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),

    effectiveDate: date("effective_date"),
    expirationDate: date("expiration_date"),

    // Lifecycle stamps
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    closeReason: text("close_reason"),

    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),

    notes: text("notes"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("commitments_org_number_key").on(
      t.organizationId,
      t.commitmentNumber
    ),
    index("commitments_job_idx").on(t.organizationId, t.jobId),
    index("commitments_vendor_idx").on(t.organizationId, t.vendorId),
    index("commitments_status_idx").on(t.organizationId, t.status),
  ]
);

/**
 * COMMITMENT LINES — per (cost code, account) allocation under one
 * commitment. Each line carries its own running invoiced_amount (sum of
 * AP bill lines linked to this commitment line).
 *
 * Lines are editable while the parent commitment is 'draft'. Once
 * issued, lines are immutable except via a future change-order flow
 * (Tier 3 territory; for v1 you must void + re-issue).
 */
export const commitmentLines = pgTable(
  "commitment_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => commitments.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    costCodeId: uuid("cost_code_id")
      .notNull()
      .references(() => costCodes.id, { onDelete: "restrict" }),

    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    invoicedAmount: numeric("invoiced_amount", {
      precision: 20,
      scale: 4,
    })
      .notNull()
      .default("0"),

    description: text("description"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("commitment_lines_co_line_key").on(
      t.commitmentId,
      t.lineNumber
    ),
    index("commitment_lines_cc_idx").on(t.organizationId, t.costCodeId),
  ]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const commitmentsRelations = relations(commitments, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [commitments.organizationId],
    references: [organizations.id],
  }),
  job: one(jobs, { fields: [commitments.jobId], references: [jobs.id] }),
  vendor: one(vendors, {
    fields: [commitments.vendorId],
    references: [vendors.id],
  }),
  lines: many(commitmentLines),
}));

export const commitmentLinesRelations = relations(
  commitmentLines,
  ({ one }) => ({
    commitment: one(commitments, {
      fields: [commitmentLines.commitmentId],
      references: [commitments.id],
    }),
    account: one(accounts, {
      fields: [commitmentLines.accountId],
      references: [accounts.id],
    }),
    costCode: one(costCodes, {
      fields: [commitmentLines.costCodeId],
      references: [costCodes.id],
    }),
  })
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Commitment = typeof commitments.$inferSelect;
export type NewCommitment = typeof commitments.$inferInsert;
export type CommitmentLine = typeof commitmentLines.$inferSelect;
export type NewCommitmentLine = typeof commitmentLines.$inferInsert;
