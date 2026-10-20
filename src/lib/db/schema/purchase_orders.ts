import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./_shared";
import { accounts } from "./accounts";
import { agents } from "./agents";
import { approvalThresholds } from "./approvals";
import { items } from "./ar";
import type { CompanyAddress } from "./company";
import { organizations, profiles } from "./identity";
import { vendors } from "./parties";

/**
 * PURCHASE ORDERS: what we've ordered from a vendor. A PO never touches
 * the ledger; the bills made from it do.
 *
 *   draft → pending_approval → open | rejected → closed
 *
 * Approval uses the bill thresholds (scope ap_bill). Only open POs are
 * sent and billed. Bills bill a PO line by pointing at it
 * (`ap_bill_lines.purchase_order_line_id`); billed = Σ those bill lines on
 * bills that aren't voided. A PO closes when every line is fully billed
 * (or by hand) and reopens when a bill from it is voided or deleted.
 */

export const purchaseOrderStatus = pgEnum("purchase_order_status", ["draft", "pending_approval", "rejected", "open", "closed"]);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    poNumber: text("po_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    poDate: date("po_date").notNull(),
    expectedDate: date("expected_date"),
    /** Where the vendor delivers; defaults to the company address. */
    shipTo: jsonb("ship_to").$type<CompanyAddress>().notNull().default({}),
    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }).notNull().default("1"),
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    /** Printed on the PO for the vendor. */
    vendorMessage: text("vendor_message"),
    /** Internal only. */
    memo: text("memo"),
    status: purchaseOrderStatus("status").notNull().default("draft"),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => profiles.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => profiles.id, { onDelete: "set null" }),
    approvalThresholdId: uuid("approval_threshold_id").references(() => approvalThresholds.id, { onDelete: "set null" }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => profiles.id, { onDelete: "set null" }),
    rejectionReason: text("rejection_reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => profiles.id, { onDelete: "set null" }),
    /** Set when closed by hand; empty when it closed by being fully billed. */
    closeReason: text("close_reason"),

    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("purchase_orders_org_number_key").on(t.organizationId, t.poNumber),
    index("purchase_orders_vendor_idx").on(t.organizationId, t.vendorId),
    index("purchase_orders_status_idx").on(t.organizationId, t.status),
  ]
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    /** Debited by the bills that bill this line. */
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    description: text("description"),
    quantity: numeric("quantity", { precision: 20, scale: 4 }).notNull().default("1"),
    unitCost: numeric("unit_cost", { precision: 20, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("purchase_order_lines_po_line_key").on(t.purchaseOrderId, t.lineNumber),
    check("purchase_order_lines_positive", sql`${t.amount} > 0`),
  ]
);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
