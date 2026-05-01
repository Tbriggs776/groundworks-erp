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
import { changeOrderStatus, timestamps } from "./_shared";
import { approvalThresholds } from "./approvals";
import { costCodes } from "./cost_codes";
import { organizations, profiles } from "./identity";
import { jobs } from "./projects";

/**
 * CHANGE ORDERS — formal contract amendments. Adjusts contract value
 * (+/-) and per-cost-code budget allocations on a job. The classic
 * construction control: scope creep gets priced, signed, and absorbed
 * into the budget instead of leaking into actual cost.
 *
 * Lifecycle (see change_order_status enum):
 *   draft → pending_approval → approved | rejected → executed → voided
 *
 * On `executed` (atomic):
 *   - jobs.contractAmount         += contractAdjustment
 *   - job_cost_codes.budgetAmount += line.amount  (per line, upsert)
 *   - All transitions audit-logged
 *
 * On `voided` (admin only, atomic):
 *   - jobs.contractAmount         -= contractAdjustment
 *   - job_cost_codes.budgetAmount -= line.amount  (per line; never deleted)
 *   - Audit row + voidReason captured
 *
 * Naming: per-org auto-numbered via the `CO` number series
 * (CO-NNNNNN). The vendor-side coNumber is the external reference (e.g.
 * the owner's CCD number) when applicable.
 */
export const changeOrders = pgTable(
  "change_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    // Numbers
    coNumber: text("co_number").notNull(), // internal, CO-NNNNNN
    externalReference: text("external_reference"), // owner CCD#, RFP#, etc.

    description: text("description").notNull(),

    // Contract impact (signed; negative for de-scope / credit COs)
    contractAdjustment: numeric("contract_adjustment", {
      precision: 20,
      scale: 4,
    })
      .notNull()
      .default("0"),
    scheduleAdjustmentDays: integer("schedule_adjustment_days")
      .notNull()
      .default(0),

    // Effective date for reporting / GAAP recognition (separate from the
    // execution timestamp). Often the date the owner signed.
    effectiveDate: date("effective_date"),

    // Workflow
    status: changeOrderStatus("status").notNull().default("draft"),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    approvalThresholdId: uuid("approval_threshold_id").references(
      () => approvalThresholds.id,
      { onDelete: "set null" }
    ),

    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    rejectionReason: text("rejection_reason"),

    executedAt: timestamp("executed_at", { withTimezone: true }),
    executedBy: uuid("executed_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),

    notes: text("notes"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("change_orders_org_co_number_key").on(
      t.organizationId,
      t.coNumber
    ),
    index("change_orders_job_idx").on(t.organizationId, t.jobId),
    index("change_orders_status_idx").on(t.organizationId, t.status),
  ]
);

/**
 * CHANGE ORDER LINES — per cost-code budget allocation. `amount` is
 * SIGNED — positive adds to budget, negative reduces. A line can target
 * a brand-new cost code on the job (the executor will insert a fresh
 * job_cost_codes row) or an existing one (executor adds to it).
 *
 * Lines may be edited freely while status='draft'. Once submitted,
 * lines are locked until rejected (which returns to draft).
 */
export const changeOrderLines = pgTable(
  "change_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    changeOrderId: uuid("change_order_id")
      .notNull()
      .references(() => changeOrders.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    costCodeId: uuid("cost_code_id")
      .notNull()
      .references(() => costCodes.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),

    description: text("description"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("change_order_lines_co_line_key").on(
      t.changeOrderId,
      t.lineNumber
    ),
    index("change_order_lines_cc_idx").on(t.organizationId, t.costCodeId),
  ]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const changeOrdersRelations = relations(changeOrders, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [changeOrders.organizationId],
    references: [organizations.id],
  }),
  job: one(jobs, { fields: [changeOrders.jobId], references: [jobs.id] }),
  threshold: one(approvalThresholds, {
    fields: [changeOrders.approvalThresholdId],
    references: [approvalThresholds.id],
  }),
  lines: many(changeOrderLines),
}));

export const changeOrderLinesRelations = relations(
  changeOrderLines,
  ({ one }) => ({
    changeOrder: one(changeOrders, {
      fields: [changeOrderLines.changeOrderId],
      references: [changeOrders.id],
    }),
    costCode: one(costCodes, {
      fields: [changeOrderLines.costCodeId],
      references: [costCodes.id],
    }),
  })
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeOrder = typeof changeOrders.$inferSelect;
export type NewChangeOrder = typeof changeOrders.$inferInsert;
export type ChangeOrderLine = typeof changeOrderLines.$inferSelect;
export type NewChangeOrderLine = typeof changeOrderLines.$inferInsert;
