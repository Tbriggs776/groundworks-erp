import { bigint, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { accounts } from "./accounts";
import { agents } from "./agents";
import { items, type DimensionTag } from "./ar";
import { organizations, profiles } from "./identity";
import { glJournals } from "./journals";

/**
 * INVENTORY. Every change to an inventory item's stock is a movement: in
 * (purchases, returns, opening stock, adjustments up) or out (sales,
 * adjustments down). A purchase's document fixes its cost; the costing
 * engine (src/lib/inventory/engine.ts) costs everything else by the
 * company's method and keeps the ledger in step through `booked_cost`.
 */

export const costingMethod = pgEnum("costing_method", ["fifo", "average", "specific"]);
export const inventoryMovementKind = pgEnum("inventory_movement_kind", ["opening", "purchase", "sale", "return", "adjustment", "vendor_return"]);
/** document: the source document fixed the cost. engine: the costing engine costs it. */
export const inventoryCostSource = pgEnum("inventory_cost_source", ["document", "engine"]);
export const inventoryAdjustmentStatus = pgEnum("inventory_adjustment_status", ["posted", "voided"]);

export const inventorySettings = pgTable(
  "inventory_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    costingMethod: costingMethod("costing_method").notNull().default("fifo"),
    ...timestamps,
  },
  (t) => [uniqueIndex("inventory_settings_org_key").on(t.organizationId)]
);

/**
 * Lots, for companies that cost by specific identification: each unit in
 * stock belongs to a lot, every line that moves stock names one, and a lot
 * is costed on its own (oldest units of the lot first).
 */
export const inventoryLots = pgTable(
  "inventory_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    lotNumber: text("lot_number").notNull(),
    expiresOn: date("expires_on"),
    ...timestamps,
  },
  (t) => [uniqueIndex("inventory_lots_item_number_key").on(t.organizationId, t.itemId, t.lotNumber)]
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    movementDate: date("movement_date").notNull(),
    /** Order within a day: first recorded, first costed. */
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity(),
    kind: inventoryMovementKind("kind").notNull(),
    /** Specific identification: the lot these units belong to. */
    lotId: uuid("lot_id").references(() => inventoryLots.id, { onDelete: "restrict" }),
    /** Signed: + into stock, − out of it. */
    quantity: numeric("quantity", { precision: 20, scale: 4 }).notNull(),
    costSource: inventoryCostSource("cost_source").notNull(),
    /** document-costed movements: their cost, fixed by the document (base currency). */
    documentCost: numeric("document_cost", { precision: 20, scale: 4 }),
    /** The movement's cost as last computed (always positive; 0 once voided). */
    cost: numeric("cost", { precision: 20, scale: 4 }).notNull().default("0"),
    /** engine-costed movements: the cost the ledger carries so far. */
    bookedCost: numeric("booked_cost", { precision: 20, scale: 4 }).notNull().default("0"),
    assetAccountId: uuid("asset_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** engine-costed movements: COGS for sales and returns, the adjustment account for adjustments. */
    offsetAccountId: uuid("offset_account_id").references(() => accounts.id, { onDelete: "restrict" }),
    dimensions: jsonb("dimensions").$type<DimensionTag[]>().notNull().default([]),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceLineId: uuid("source_line_id"),
    /** "Invoice INV-000012", for history and journal descriptions. */
    label: text("label").notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidDate: date("void_date"),
    ...timestamps,
  },
  (t) => [
    index("inventory_movements_item_idx").on(t.organizationId, t.itemId, t.movementDate, t.sequence),
    index("inventory_movements_source_idx").on(t.organizationId, t.sourceType, t.sourceId),
  ]
);

/** Each journal the costing engine posted for a movement, and how much. */
export const inventoryCostPostings = pgTable(
  "inventory_cost_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    movementId: uuid("movement_id")
      .notNull()
      .references(() => inventoryMovements.id, { onDelete: "restrict" }),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => glJournals.id, { onDelete: "restrict" }),
    /** Change in the movement's booked cost. */
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    postedOn: date("posted_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("inventory_cost_postings_movement_idx").on(t.movementId)]
);

/** Quantity adjustments and opening stock. Posted when saved; voiding reverses. */
export const inventoryAdjustments = pgTable(
  "inventory_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    adjustmentNumber: text("adjustment_number").notNull(),
    adjustmentDate: date("adjustment_date").notNull(),
    /** opening: an item's starting stock. adjustment: a count, shrinkage, or found stock. */
    kind: text("kind").notNull().default("adjustment"),
    /** Where the difference goes: shrinkage, COGS, or Opening Balance Equity. */
    offsetAccountId: uuid("offset_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    memo: text("memo"),
    status: inventoryAdjustmentStatus("status").notNull().default("posted"),
    /** The journal for stock added (stock removed is costed by the engine). */
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
    voidGlJournalId: uuid("void_gl_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("inventory_adjustments_org_number_key").on(t.organizationId, t.adjustmentNumber)]
);

export const inventoryAdjustmentLines = pgTable(
  "inventory_adjustment_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    adjustmentId: uuid("adjustment_id")
      .notNull()
      .references(() => inventoryAdjustments.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "restrict" }),
    /** Change in quantity: + adds stock, − removes it. */
    quantity: numeric("quantity", { precision: 20, scale: 4 }).notNull(),
    /** Stock added: its cost per unit. */
    unitCost: numeric("unit_cost", { precision: 20, scale: 4 }),
    /** Specific identification: the lot (stock added may start a new one). */
    lotNumber: text("lot_number"),
    lotExpiresOn: date("lot_expires_on"),
    ...timestamps,
  },
  (t) => [uniqueIndex("inventory_adjustment_lines_key").on(t.adjustmentId, t.lineNumber)]
);

export type InventoryLot = typeof inventoryLots.$inferSelect;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InventoryAdjustment = typeof inventoryAdjustments.$inferSelect;
export type InventoryAdjustmentLine = typeof inventoryAdjustmentLines.$inferSelect;
