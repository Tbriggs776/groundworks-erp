import type Decimal from "decimal.js";
import { addDays, format, parseISO } from "date-fns";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { inventoryMovements, inventorySettings, type InventoryMovement, type Item } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { getItem } from "@/lib/ar/items";
import { AppError, invalidState } from "@/lib/errors";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { id, isoDate } from "@/lib/schemas";
import { Range, range, rangeLabel } from "@/lib/reports/statements";
import { fmt2, type ReportRow, type ReportTable } from "@/lib/reports/table";
import { costingMethod, stockOf, type CostingMethod } from "./engine";
import { listLots, lotNumbers, type LotRow } from "./lots";

/**
 * What's on hand: the costing method (set once per company), an item's
 * stock and history, and the inventory reports (valuation, valuation
 * detail, stock status).
 */

const today = () => format(new Date(), "yyyy-MM-dd");
const day = (d: string) => format(parseISO(d), "MMM d, yyyy");

export const METHOD_LABEL: Record<CostingMethod, string> = {
  fifo: "FIFO (first in, first out)",
  average: "Weighted average",
  specific: "Specific identification (by lot)",
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const UpdateInventorySettingsSchema = z.object({
  costingMethod: z
    .enum(["fifo", "average", "specific"])
    .describe(
      "fifo: a sale costs the oldest units on hand. average: a sale costs the running average. specific: every inventory line names a lot, and a sale costs the units of its lot (lot numbers and expiration dates). Set once: it can't change after the first stock movement."
    ),
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
  vendor_credit: "/ap/vendor-credits",
  inventory_adjustment: "/items/adjustments",
};

const hrefOf = (sourceType: string, sourceId: string) => (SOURCE_HREF[sourceType] ? `${SOURCE_HREF[sourceType]}/${sourceId}` : undefined);

export type StockMovementRow = Pick<InventoryMovement, "id" | "movementDate" | "kind" | "label" | "quantity" | "cost" | "sourceType" | "sourceId"> & {
  voided: boolean;
  /** Quantity on hand after this movement. */
  onHand: string;
  href: string | null;
  lotNumber: string | null;
};

export type ItemStock = {
  item: Item;
  costingMethod: CostingMethod;
  onHand: string;
  value: string;
  /** Average cost of what's on hand (or, with none, what the next sale would cost per unit). */
  unitCost: string;
  belowReorderPoint: boolean;
  /** Specific identification: the item's lots with stock (or short). */
  lots: LotRow[];
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
  const lotNames = await lotNumbers(ctx, [...new Set(ms.map((m) => m.lotId).filter((x): x is string => Boolean(x)))]);
  let running = money(0);
  const rows: StockMovementRow[] = ms.map((m) => {
    if (!m.voidedAt) running = running.plus(money(m.quantity));
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
      href: hrefOf(m.sourceType, m.sourceId) ?? null,
      lotNumber: m.lotId ? (lotNames.get(m.lotId) ?? null) : null,
    };
  });
  const unit = s.onHand.gt(0) ? s.value.div(s.onHand) : s.unitCost;
  const method = await costingMethod(ctx);
  return {
    item,
    costingMethod: method,
    lots: method === "specific" ? await listLots(ctx, { itemId: item.id, inStock: true }) : [],
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

// ---------------------------------------------------------------------------
// Inventory valuation detail
// ---------------------------------------------------------------------------

export const ValuationDetailSchema = z.object({ ...Range, itemId: id.optional().describe("One item; default all inventory items.") });

/**
 * Every change to quantity and value per inventory item for a date range,
 * from the opening balance to the closing one, on the day it hit the
 * ledger: stock bought on its date (taken back on a void's date), and each
 * cost entry the engine posted on the day it posted. Closing values tie to
 * the valuation report and the inventory asset accounts.
 */
export async function valuationDetail(ctx: Ctx, input: z.input<typeof ValuationDetailSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the inventory valuation detail report");
  const f = ValuationDetailSchema.parse(input);
  const { from, to } = range(f);
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<{
    item_id: string;
    name: string;
    d: string;
    label: string;
    source_type: string;
    source_id: string;
    qty: string;
    val: string;
  }>(sql`
    WITH m AS (
      SELECT * FROM inventory_movements WHERE organization_id = ${org} ${f.itemId ? sql`AND item_id = ${f.itemId}` : sql``}
    ),
    ev AS (
      SELECT m.item_id, m.movement_date AS d, m.sequence AS seq, false AS void, m.label, m.source_type, m.source_id, m.quantity AS qty,
             CASE WHEN m.cost_source = 'document' THEN m.document_cost ELSE 0 END AS val
        FROM m
      UNION ALL
      SELECT m.item_id, m.void_date, m.sequence, true, m.label, m.source_type, m.source_id, -m.quantity,
             CASE WHEN m.cost_source = 'document' THEN -m.document_cost ELSE 0 END
        FROM m WHERE m.voided_at IS NOT NULL
      UNION ALL
      SELECT m.item_id, p.posted_on, m.sequence, false, m.label, m.source_type, m.source_id, 0,
             CASE WHEN m.quantity > 0 THEN p.amount ELSE -p.amount END
        FROM inventory_cost_postings p JOIN m ON m.id = p.movement_id
    )
    SELECT ev.item_id, i.name, ev.d::text AS d,
           CASE WHEN bool_or(ev.void) THEN 'Void of ' || ev.label ELSE ev.label END AS label,
           ev.source_type, ev.source_id::text AS source_id,
           SUM(ev.qty)::text AS qty, SUM(ev.val)::text AS val
      FROM ev JOIN items i ON i.id = ev.item_id
     WHERE ev.d <= ${to}::date
     GROUP BY ev.item_id, i.name, ev.d, ev.seq, ev.label, ev.source_type, ev.source_id
     ORDER BY i.name, ev.d, ev.seq
  `);
  const byItem = new Map<string, { name: string; openQty: Decimal; openVal: Decimal; events: typeof rows }>();
  for (const r of rows) {
    const g = byItem.get(r.item_id) ?? { name: r.name, openQty: money(0), openVal: money(0), events: [] as unknown as typeof rows };
    if (r.d < from) {
      g.openQty = g.openQty.plus(money(r.qty));
      g.openVal = g.openVal.plus(money(r.val));
    } else if (!money(r.qty).isZero() || !money(r.val).isZero()) {
      g.events.push(r);
    }
    byItem.set(r.item_id, g);
  }
  const out: ReportRow[] = [];
  let total = money(0);
  for (const [itemId, g] of byItem) {
    if (g.events.length === 0 && g.openQty.isZero() && g.openVal.isZero()) continue;
    out.push({ kind: "section", label: g.name, href: `/items/${itemId}`, values: [null, null, null, null, null] });
    out.push({ kind: "account", label: "Opening balance", depth: 1, values: [from, null, null, qtyText(g.openQty), fmt2(g.openVal)] });
    let q = g.openQty;
    let v = g.openVal;
    for (const e of g.events) {
      q = q.plus(money(e.qty));
      v = v.plus(money(e.val));
      out.push({
        kind: "account",
        label: e.label,
        depth: 1,
        href: hrefOf(e.source_type, e.source_id),
        values: [e.d, money(e.qty).isZero() ? null : qtyText(money(e.qty)), fmt2(money(e.val)), qtyText(q), fmt2(v)],
      });
    }
    out.push({ kind: "subtotal", label: `Total ${g.name}`, values: [to, null, fmt2(v.minus(g.openVal)), qtyText(q), fmt2(v)] });
    total = total.plus(v);
  }
  out.push({ kind: "total", label: "Total inventory", values: [null, null, null, null, fmt2(total)] });
  return {
    title: "Inventory Valuation Detail",
    subtitle: rangeLabel(from, to),
    labelColumn: "Transaction",
    columns: ["Date", "Quantity", "Value", "Qty on hand", "Asset value"],
    columnKinds: ["text", "number", "money", "number", "money"],
    rows: out,
    notes: [
      "Each change on the day it reached the ledger: stock bought on its date (taken back on a void's date), and cost of goods entries on the day they posted, including recosts when something earlier changed. Closing values match the inventory valuation report.",
    ],
  };
}

const qtyText = (d: Decimal) => d.toDecimalPlaces(4).toString();

// ---------------------------------------------------------------------------
// Stock status
// ---------------------------------------------------------------------------

export const StockStatusSchema = z.object({
  expiringDays: z.coerce.number().int().min(0).max(365).default(30).describe("Lots expiring within this many days are flagged. Default 30."),
});

/**
 * What to reorder: quantity on hand, the reorder point, what's on open
 * purchase orders and when it's due, and (with lots) what expires soon.
 * Reorder when on hand plus on order is at or below the reorder point; On
 * order when on hand is low but open purchase orders cover it.
 */
export async function stockStatus(ctx: Ctx, input: z.input<typeof StockStatusSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the inventory stock status report");
  const f = StockStatusSchema.parse(input);
  const org = ctx.actor.organizationId;
  const now = today();
  const soon = format(addDays(parseISO(now), f.expiringDays), "yyyy-MM-dd");
  const items = await ctx.tx.execute<{
    id: string;
    name: string;
    sku: string | null;
    reorder_point: string | null;
    on_hand: string;
    on_po: string;
    next_delivery: string | null;
  }>(sql`
    WITH open_lines AS (
      SELECT pl.item_id, po.expected_date,
             pl.quantity - COALESCE((
               SELECT SUM(COALESCE(bl.quantity, pl.quantity * bl.amount / NULLIF(pl.amount, 0)))
                 FROM ap_bill_lines bl JOIN ap_bills b ON b.id = bl.bill_id
                WHERE bl.purchase_order_line_id = pl.id AND b.status <> 'voided' AND b.deleted_at IS NULL
             ), 0) AS left_qty
        FROM purchase_order_lines pl
        JOIN purchase_orders po ON po.id = pl.purchase_order_id
       WHERE po.organization_id = ${org} AND po.status = 'open' AND po.deleted_at IS NULL AND pl.item_id IS NOT NULL
    )
    SELECT i.id, i.name, i.sku, i.reorder_point::text,
           COALESCE((SELECT SUM(m.quantity) FROM inventory_movements m WHERE m.item_id = i.id AND m.voided_at IS NULL), 0)::text AS on_hand,
           COALESCE((SELECT SUM(o.left_qty) FROM open_lines o WHERE o.item_id = i.id AND o.left_qty > 0), 0)::text AS on_po,
           (SELECT MIN(o.expected_date)::text FROM open_lines o WHERE o.item_id = i.id AND o.left_qty > 0) AS next_delivery
      FROM items i
     WHERE i.organization_id = ${org} AND i.type = 'inventory' AND i.is_active AND i.deleted_at IS NULL
     ORDER BY i.name
  `);
  const lots = (await costingMethod(ctx)) === "specific" ? await listLots(ctx, { inStock: true }) : [];
  const lotsOf = new Map<string, LotRow[]>();
  for (const l of lots) lotsOf.set(l.itemId, [...(lotsOf.get(l.itemId) ?? []), l]);
  const expiry = (l: LotRow) =>
    l.expiresOn && money(l.onHand).gt(0) ? (l.expiresOn < now ? "Expired" : l.expiresOn <= soon ? "Expiring" : null) : null;

  const out: ReportRow[] = [];
  for (const r of items) {
    const onHand = money(r.on_hand);
    const onPo = money(r.on_po);
    const status: string[] = [];
    if (onHand.lt(0)) status.push("Negative");
    if (r.reorder_point !== null && onHand.lte(money(r.reorder_point))) {
      status.push(onHand.plus(onPo).lte(money(r.reorder_point)) ? "Reorder" : "On order");
    }
    const itemLots = lotsOf.get(r.id) ?? [];
    const flags = itemLots.map(expiry);
    if (flags.includes("Expired")) status.push("Lot expired");
    else if (flags.includes("Expiring")) status.push("Lot expiring");
    const firstExpiry = itemLots.filter((l) => l.expiresOn && money(l.onHand).gt(0)).map((l) => l.expiresOn!).sort()[0] ?? null;
    out.push({
      kind: "account",
      label: r.name,
      code: r.sku ?? undefined,
      href: `/items/${r.id}`,
      values: [qtyText(onHand), r.reorder_point === null ? null : qtyText(money(r.reorder_point)), onPo.isZero() ? null : qtyText(onPo), r.next_delivery, firstExpiry, status.join(" · ") || null],
    });
    for (const l of itemLots) {
      out.push({ kind: "account", label: `Lot ${l.lotNumber}`, depth: 1, values: [qtyText(money(l.onHand)), null, null, null, l.expiresOn, expiry(l)] });
    }
  }
  return {
    title: "Inventory Stock Status",
    subtitle: `As of ${day(now)}`,
    labelColumn: "Product",
    columns: ["On hand", "Reorder point", "On PO", "Next delivery", "Expires", "Status"],
    columnKinds: ["number", "number", "number", "text", "text", "text"],
    rows: out,
    notes: [
      `Reorder: on hand plus open purchase orders is at or below the reorder point. On order: on hand is low, but open purchase orders cover it.${lots.length > 0 ? ` Lots expiring within ${f.expiringDays} days are flagged.` : ""}`,
    ],
  };
}
