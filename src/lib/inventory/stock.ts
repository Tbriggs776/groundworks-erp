import { format, parseISO } from "date-fns";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { inventoryMovements, inventorySettings, type InventoryMovement, type Item } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { getItem } from "@/lib/ar/items";
import { AppError, invalidState } from "@/lib/errors";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { id, isoDate } from "@/lib/schemas";
import { fmt2, type ReportRow, type ReportTable } from "@/lib/reports/table";
import { costingMethod, stockOf, type CostingMethod } from "./engine";

/**
 * What's on hand: the costing method (set once per company), an item's
 * stock and history, and the inventory valuation report.
 */

const today = () => format(new Date(), "yyyy-MM-dd");
const day = (d: string) => format(parseISO(d), "MMM d, yyyy");

export const METHOD_LABEL: Record<CostingMethod, string> = { fifo: "FIFO (first in, first out)", average: "Weighted average" };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const UpdateInventorySettingsSchema = z.object({
  costingMethod: z
    .enum(["fifo", "average"])
    .describe("fifo: a sale costs the oldest units on hand. average: a sale costs the running average. Set once: it can't change after the first stock movement."),
});

export type InventorySettingsView = { costingMethod: CostingMethod; locked: boolean };

async function hasActivity(ctx: Ctx): Promise<boolean> {
  const [m] = await ctx.tx
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.organizationId, ctx.actor.organizationId))
    .limit(1);
  return Boolean(m);
}

export async function getInventorySettings(ctx: Ctx): Promise<InventorySettingsView> {
  requirePermission(ctx.actor, "read", "viewer", "view inventory settings");
  return { costingMethod: await costingMethod(ctx), locked: await hasActivity(ctx) };
}

export async function updateInventorySettings(ctx: Ctx, input: z.input<typeof UpdateInventorySettingsSchema>): Promise<InventorySettingsView> {
  requirePermission(ctx.actor, "admin", "admin", "change the inventory costing method");
  const d = UpdateInventorySettingsSchema.parse(input);
  const org = ctx.actor.organizationId;
  // Serializes with a movement being recorded: its foreign key check share-locks this row.
  await ctx.tx.execute(sql`SELECT 1 FROM organizations WHERE id = ${org} FOR UPDATE`);
  const before = await costingMethod(ctx);
  if (before === d.costingMethod) return { costingMethod: before, locked: await hasActivity(ctx) };
  if (await hasActivity(ctx)) {
    throw invalidState(`The costing method is set once, and this company already has inventory activity. It stays ${METHOD_LABEL[before]}.`);
  }
  await ctx.tx
    .insert(inventorySettings)
    .values({ organizationId: org, costingMethod: d.costingMethod })
    .onConflictDoUpdate({ target: inventorySettings.organizationId, set: { costingMethod: d.costingMethod, updatedAt: sql`now()` } });
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "inventory.settings.updated",
      entityType: "organization",
      entityId: org,
      metadata: { costingMethod: { from: before, to: d.costingMethod } },
    },
    ctx.tx
  );
  return { costingMethod: d.costingMethod, locked: false };
}

// ---------------------------------------------------------------------------
// An item's stock
// ---------------------------------------------------------------------------

export const ItemStockSchema = z.object({ id, limit: z.coerce.number().int().min(1).max(1000).default(200) });

const SOURCE_HREF: Record<string, string> = {
  ar_invoice: "/ar/invoices",
  sales_receipt: "/ar/sales-receipts",
  credit_memo: "/ar/credit-memos",
  refund_receipt: "/ar/refunds",
  ap_bill: "/ap/bills",
  bank_transaction: "/banking/transactions",
  inventory_adjustment: "/items/adjustments",
};

export type StockMovementRow = Pick<InventoryMovement, "id" | "movementDate" | "kind" | "label" | "quantity" | "cost" | "sourceType" | "sourceId"> & {
  voided: boolean;
  /** Quantity on hand after this movement. */
  onHand: string;
  href: string | null;
};

export type ItemStock = {
  item: Item;
  costingMethod: CostingMethod;
  onHand: string;
  value: string;
  /** Average cost of what's on hand (or, with none, what the next sale would cost per unit). */
  unitCost: string;
  belowReorderPoint: boolean;
  /** Newest first. */
  movements: StockMovementRow[];
  totalMovements: number;
};

export async function getItemStock(ctx: Ctx, input: z.input<typeof ItemStockSchema>): Promise<ItemStock> {
  requirePermission(ctx.actor, "read", "viewer", "view stock");
  const f = ItemStockSchema.parse(input);
  const item = await getItem(ctx, { id: f.id });
  if (item.type !== "inventory") throw new AppError("invalid_input", `${item.name} isn't an inventory item.`);
  const s = await stockOf(ctx, item.id);
  const ms = await ctx.tx
    .select()
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.organizationId, ctx.actor.organizationId), eq(inventoryMovements.itemId, item.id)))
    .orderBy(asc(inventoryMovements.movementDate), asc(inventoryMovements.sequence));
  let running = money(0);
  const rows: StockMovementRow[] = ms.map((m) => {
    if (!m.voidedAt) running = running.plus(money(m.quantity));
    const base = SOURCE_HREF[m.sourceType];
    return {
      id: m.id,
      movementDate: m.movementDate,
      kind: m.kind,
      label: m.label,
      quantity: m.quantity,
      cost: m.cost,
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      voided: Boolean(m.voidedAt),
      onHand: toDbMoney(running),
      href: base ? `${base}/${m.sourceId}` : null,
    };
  });
  const unit = s.onHand.gt(0) ? s.value.div(s.onHand) : s.unitCost;
  return {
    item,
    costingMethod: await costingMethod(ctx),
    onHand: toDbMoney(s.onHand),
    value: toDbMoney(s.value),
    unitCost: toDbMoney(unit),
    belowReorderPoint: item.reorderPoint !== null && s.onHand.lte(money(item.reorderPoint)),
    movements: rows.reverse().slice(0, f.limit),
    totalMovements: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Inventory valuation
// ---------------------------------------------------------------------------

export const InventoryValuationSchema = z.object({ asOf: isoDate.optional().describe("Default today.") });

/**
 * Quantity and value of every inventory item as of a date. Value counts
 * stock bought (until a void) plus every cost entry the engine posted by
 * then, so it ties to the inventory asset accounts in the ledger.
 */
export async function inventoryValuation(ctx: Ctx, input: z.input<typeof InventoryValuationSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the inventory valuation report");
  const asOf = InventoryValuationSchema.parse(input).asOf ?? today();
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<{ id: string; name: string; sku: string | null; is_active: boolean; reorder_point: string | null; quantity: string; value: string }>(sql`
    WITH counted AS (
      SELECT m.item_id, m.quantity, m.cost_source, m.document_cost
        FROM inventory_movements m
       WHERE m.organization_id = ${org}
         AND m.movement_date <= ${asOf}::date
         AND (m.voided_at IS NULL OR m.void_date > ${asOf}::date)
    ),
    engine AS (
      SELECT m.item_id, SUM(CASE WHEN m.quantity > 0 THEN p.amount ELSE -p.amount END) AS value
        FROM inventory_cost_postings p
        JOIN inventory_movements m ON m.id = p.movement_id
       WHERE p.organization_id = ${org} AND p.posted_on <= ${asOf}::date
       GROUP BY 1
    ),
    bought AS (
      SELECT item_id, SUM(quantity) AS quantity, SUM(CASE WHEN cost_source = 'document' THEN document_cost ELSE 0 END) AS value
        FROM counted GROUP BY 1
    )
    SELECT i.id, i.name, i.sku, i.is_active, i.reorder_point::text,
           COALESCE(b.quantity, 0)::text AS quantity,
           (COALESCE(b.value, 0) + COALESCE(e.value, 0))::text AS value
      FROM items i
      LEFT JOIN bought b ON b.item_id = i.id
      LEFT JOIN engine e ON e.item_id = i.id
     WHERE i.organization_id = ${org} AND i.type = 'inventory' AND i.deleted_at IS NULL
     ORDER BY i.name
  `);
  const [gl] = await ctx.tx.execute<{ balance: string | null }>(sql`
    SELECT SUM(l.debit_local - l.credit_local)::text AS balance
      FROM gl_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id
     WHERE l.organization_id = ${org}
       AND j.status IN ('posted', 'reversed')
       AND j.journal_date <= ${asOf}::date
       AND a.subcategory = 'inventory'
  `);
  const parsed = rows
    .map((r) => ({ ...r, qty: money(r.quantity), val: money(r.value) }))
    .filter((r) => r.is_active || !r.qty.isZero() || !r.val.isZero());
  const out: ReportRow[] = parsed.map((r) => ({
    kind: "account",
    label: r.name,
    code: r.sku ?? undefined,
    href: `/items/${r.id}`,
    values: [
      r.qty.toDecimalPlaces(4).toString(),
      r.qty.gt(0) ? fmt2(r.val.div(r.qty)) : null,
      fmt2(r.val),
      r.qty.lt(0) ? "Negative" : r.reorder_point !== null && r.qty.lte(money(r.reorder_point)) ? "Reorder" : null,
    ],
  }));
  const total = sumMoney(parsed.map((r) => r.val));
  out.push({ kind: "total", label: "Total", values: [null, null, fmt2(total), null] });
  const ledger = money(gl?.balance ?? 0);
  const notes = [
    `Inventory asset accounts in the ledger on ${day(asOf)}: ${fmt2(ledger)}.${ledger.eq(total) ? " Matches." : ` Differs by ${fmt2(ledger.minus(total))}: entries posted straight to an inventory account (journal entries, or a bill or expense line without an item) aren't stock.`}`,
  ];
  if (parsed.some((r) => r.qty.lt(0))) {
    notes.push("Negative quantities: more was sold than was on hand. Those units are costed at the last known cost until stock comes in, then recost.");
  }
  return {
    title: "Inventory Valuation",
    subtitle: `As of ${day(asOf)} · ${METHOD_LABEL[await costingMethod(ctx)]}`,
    labelColumn: "Product",
    columns: ["Quantity on hand", "Avg cost", "Asset value", "Status"],
    columnKinds: ["number", "money", "money", "text"],
    rows: out,
    notes,
  };
}
