import Decimal from "decimal.js";
import { format } from "date-fns";
import { and, asc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  fiscalPeriods,
  inventoryCostPostings,
  inventoryMovements,
  inventorySettings,
  items,
  type DimensionTag,
  type InventoryMovement,
  type Item,
} from "@/lib/db/schema";
import type { Ctx } from "@/lib/actor";
import { AppError } from "@/lib/errors";
import { sourceCodeId } from "@/lib/gl/lookups";
import { createAndPostJournal, type JournalLineInput } from "@/lib/gl/posting";
import { money, toDbMoney } from "@/lib/money";

/**
 * THE COSTING ENGINE. An inventory item's movements, in date order (then
 * the order they were recorded), decide what every sale cost:
 *
 *   fifo     a sale takes the oldest units still on hand
 *   average  a sale takes the running average cost of what's on hand
 *
 * Purchases (and stock added by an adjustment) carry the cost their
 * document gave them. Everything else is costed here: sales and stock
 * removed by an adjustment take units off; returns put them back at the
 * cost they last went out at (average: the current average).
 *
 * Selling more than is on hand is allowed. The units short are costed at
 * the last known unit cost for now; the next units in fill them, and the
 * sale's cost moves to what those units cost.
 *
 * After any change (a new movement, a void, something dated earlier than
 * later sales) the item is recosted from scratch. Each engine-costed
 * movement compares its new cost with the cost the ledger carries
 * (`booked_cost`) and the difference posts as an inventory journal (Dr COGS
 * / Cr Inventory, or the reverse) on the movement's date: its void date for
 * a void, or the first day not hard closed when that date is. Inventory
 * journals post into soft-closed periods (they're adjustments).
 */

export type CostingMethod = "fifo" | "average";

const ZERO = money(0);
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const min = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);
const today = () => format(new Date(), "yyyy-MM-dd");

export async function costingMethod(ctx: Ctx): Promise<CostingMethod> {
  const [s] = await ctx.tx
    .select({ method: inventorySettings.costingMethod })
    .from(inventorySettings)
    .where(eq(inventorySettings.organizationId, ctx.actor.organizationId));
  return s?.method === "average" ? "average" : "fifo";
}

/** The inventory items among these ids, by id. */
export async function inventoryItems(ctx: Ctx, itemIds: Array<string | null | undefined>): Promise<Map<string, Item>> {
  const ids = [...new Set(itemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx
    .select()
    .from(items)
    .where(and(eq(items.organizationId, ctx.actor.organizationId), inArray(items.id, ids), eq(items.type, "inventory")));
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// The calculation (pure)
// ---------------------------------------------------------------------------

type Costable = Pick<InventoryMovement, "id" | "quantity" | "costSource" | "documentCost" | "voidedAt">;

export type CostResult = {
  /** Cost of each movement (positive; 0 when voided). */
  costs: Map<string, Decimal>;
  onHand: Decimal;
  value: Decimal;
  /** What a unit costs now: the average, or the last unit cost in. */
  unitCost: Decimal;
};

/** Cost every movement of one item, given in date order. */
export function computeCosts(ms: Costable[], method: CostingMethod, fallbackUnit: Decimal = ZERO): CostResult {
  const costs = new Map<string, Decimal>();
  const fromStock = new Map<string, Decimal>();
  const filled = new Map<string, Decimal>();
  const pending: Array<{ id: string; short: Decimal; provisional: Decimal }> = [];
  const layers: Array<{ qty: Decimal; value: Decimal }> = [];
  let qty = ZERO;
  let value = ZERO;
  let lastUnit = fallbackUnit;
  let lastOutUnit: Decimal | null = null;

  const currentUnit = () => (method === "average" ? (qty.gt(0) ? value.div(qty) : lastUnit) : (lastOutUnit ?? lastUnit));

  for (const m of ms) {
    if (m.voidedAt) {
      costs.set(m.id, ZERO);
      continue;
    }
    const q = money(m.quantity);
    if (q.gt(0)) {
      const total = m.costSource === "document" ? money(m.documentCost ?? 0) : round2(currentUnit().times(q));
      const unit = total.div(q);
      costs.set(m.id, total);
      // Units in fill earlier shortfalls first, at this movement's cost.
      let rem = q;
      let used = ZERO;
      while (pending.length > 0 && rem.gt(0)) {
        const p = pending[0];
        const take = min(p.short, rem);
        const part = round2(unit.times(take));
        filled.set(p.id, (filled.get(p.id) ?? ZERO).plus(part));
        used = used.plus(part);
        p.short = p.short.minus(take);
        rem = rem.minus(take);
        if (p.short.isZero()) pending.shift();
      }
      if (rem.gt(0)) {
        const remValue = total.minus(used);
        if (method === "fifo") layers.push({ qty: rem, value: remValue });
        qty = qty.plus(rem);
        value = value.plus(remValue);
      }
      lastUnit = unit;
    } else if (q.lt(0)) {
      const n = q.neg();
      let need = n;
      let cost = ZERO;
      if (method === "fifo") {
        while (need.gt(0) && layers.length > 0) {
          const l = layers[0];
          const take = min(l.qty, need);
          const part = take.eq(l.qty) ? l.value : round2(l.value.times(take).div(l.qty));
          cost = cost.plus(part);
          l.qty = l.qty.minus(take);
          l.value = l.value.minus(part);
          need = need.minus(take);
          if (l.qty.isZero()) layers.shift();
        }
      } else if (qty.gt(0)) {
        const take = min(qty, need);
        cost = take.eq(qty) ? value : round2(value.times(take).div(qty));
        need = need.minus(take);
      }
      const taken = n.minus(need);
      qty = qty.minus(taken);
      value = value.minus(cost);
      fromStock.set(m.id, cost);
      if (need.gt(0)) pending.push({ id: m.id, short: need, provisional: lastUnit });
      lastOutUnit = n.gt(0) ? cost.plus(need.times(lastUnit)).div(n) : lastOutUnit;
    } else {
      costs.set(m.id, ZERO);
    }
  }
  // Outs: what came from stock, what later units filled, and any still short at the provisional cost.
  // Units still short count against the value too, so it ties to the ledger.
  const short = new Map(pending.map((p) => [p.id, p]));
  let provisional = ZERO;
  for (const m of ms) {
    if (m.voidedAt || !money(m.quantity).lt(0)) continue;
    const p = short.get(m.id);
    const known = (fromStock.get(m.id) ?? ZERO).plus(filled.get(m.id) ?? ZERO);
    const cost = round2(known.plus(p ? p.short.times(p.provisional) : ZERO));
    costs.set(m.id, cost);
    provisional = provisional.plus(cost.minus(known));
  }
  const owed = pending.reduce((acc, p) => acc.plus(p.short), ZERO);
  return { costs, onHand: qty.minus(owed), value: value.minus(provisional), unitCost: currentUnit() };
}

// ---------------------------------------------------------------------------
// Recording, voiding, recosting
// ---------------------------------------------------------------------------

export type NewMovement = {
  itemId: string;
  date: string;
  kind: InventoryMovement["kind"];
  /** Signed: + in, − out. */
  quantity: string;
  /** Purchases and stock added by an adjustment: the cost the document fixed (base currency). */
  documentCost?: string;
  assetAccountId: string;
  offsetAccountId?: string | null;
  dimensions?: DimensionTag[];
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  label: string;
};

/** Record movements, then recost their items. */
export async function recordMovements(ctx: Ctx, ms: NewMovement[]) {
  if (ms.length === 0) return;
  await ctx.tx.insert(inventoryMovements).values(
    ms.map((m) => ({
      organizationId: ctx.actor.organizationId,
      itemId: m.itemId,
      movementDate: m.date,
      kind: m.kind,
      quantity: m.quantity,
      costSource: m.documentCost !== undefined ? ("document" as const) : ("engine" as const),
      documentCost: m.documentCost ?? null,
      assetAccountId: m.assetAccountId,
      offsetAccountId: m.offsetAccountId ?? null,
      dimensions: m.dimensions ?? [],
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      sourceLineId: m.sourceLineId ?? null,
      label: m.label,
    }))
  );
  await recostItems(ctx, ms.map((m) => m.itemId));
}

/** A document was voided: its movements stop counting (as of `voidDate` for the ledger), then recost. */
export async function voidMovements(ctx: Ctx, sourceType: string, sourceId: string, voidDate: string = today()) {
  const rows = await ctx.tx
    .update(inventoryMovements)
    .set({ voidedAt: sql`now()`, voidDate, updatedAt: sql`now()` })
    .where(
      and(
        eq(inventoryMovements.organizationId, ctx.actor.organizationId),
        eq(inventoryMovements.sourceType, sourceType),
        eq(inventoryMovements.sourceId, sourceId),
        isNull(inventoryMovements.voidedAt)
      )
    )
    .returning({ itemId: inventoryMovements.itemId });
  await recostItems(ctx, rows.map((r) => r.itemId));
}

/** The first date on or after `date` the ledger takes inventory journals on (not hard closed). */
async function postableDate(ctx: Ctx, date: string): Promise<string> {
  const [p] = await ctx.tx
    .select({ start: fiscalPeriods.startDate })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.organizationId, ctx.actor.organizationId), gte(fiscalPeriods.endDate, date), ne(fiscalPeriods.status, "hard_closed")))
    .orderBy(asc(fiscalPeriods.startDate))
    .limit(1);
  if (!p) throw new AppError("invalid_state", `There's no open fiscal period on or after ${date} for an inventory cost entry. Generate the next fiscal year.`);
  return p.start > date ? p.start : date;
}

/** Recost items and post what changed. Items are locked one at a time in id order. */
export async function recostItems(ctx: Ctx, itemIds: string[]) {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return;
  const method = await costingMethod(ctx);
  for (const itemId of ids) await recostItem(ctx, itemId, method);
}

type Diff = { m: InventoryMovement; diff: Decimal };

async function recostItem(ctx: Ctx, itemId: string, method: CostingMethod) {
  const org = ctx.actor.organizationId;
  const [item] = await ctx.tx.execute<{ name: string; purchase_cost: string | null }>(
    sql`SELECT name, purchase_cost::text FROM items WHERE id = ${itemId} AND organization_id = ${org} FOR UPDATE`
  );
  if (!item) throw new AppError("not_found", "Item not found.");
  const ms = await ctx.tx
    .select()
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.organizationId, org), eq(inventoryMovements.itemId, itemId)))
    .orderBy(asc(inventoryMovements.movementDate), asc(inventoryMovements.sequence));
  const { costs } = computeCosts(ms, method, money(item.purchase_cost ?? 0));

  const diffs: Diff[] = [];
  for (const m of ms) {
    const cost = costs.get(m.id) ?? ZERO;
    if (!cost.eq(money(m.cost))) {
      await ctx.tx.update(inventoryMovements).set({ cost: toDbMoney(cost), updatedAt: sql`now()` }).where(eq(inventoryMovements.id, m.id));
    }
    if (m.costSource !== "engine") continue;
    const diff = cost.minus(money(m.bookedCost));
    if (!diff.isZero()) diffs.push({ m, diff });
  }
  if (diffs.length > 0) await postDiffs(ctx, item.name, diffs);
}

/** One inventory journal per date and source document. */
async function postDiffs(ctx: Ctx, itemName: string, diffs: Diff[]) {
  const groups = new Map<string, { date: string; label: string; voided: boolean; initial: boolean; sale: boolean; rows: Diff[] }>();
  for (const d of diffs) {
    const date = await postableDate(ctx, d.m.voidedAt ? (d.m.voidDate ?? today()) : d.m.movementDate);
    const key = `${date}|${d.m.sourceType}|${d.m.sourceId}|${d.m.voidedAt ? "void" : ""}`;
    const sale = d.m.kind === "sale" || d.m.kind === "return";
    const g = groups.get(key) ?? { date, label: d.m.label, voided: Boolean(d.m.voidedAt), initial: true, sale, rows: [] };
    g.initial = g.initial && money(d.m.bookedCost).isZero();
    g.rows.push(d);
    groups.set(key, g);
  }
  const org = ctx.actor.organizationId;
  const code = await sourceCodeId(ctx.tx, org, "INV");
  for (const g of groups.values()) {
    const lines: JournalLineInput[] = [];
    for (const { m, diff } of g.rows) {
      const out = money(m.quantity).lt(0);
      // An out raises the offset (COGS) and lowers stock; a return in does the reverse.
      const offsetDebit = out === diff.gt(0);
      const amt = toDbMoney(diff.abs());
      const memo = `${itemName} × ${money(m.quantity).abs().toString()}`;
      lines.push(
        { accountId: m.offsetAccountId!, ...(offsetDebit ? { debit: amt } : { credit: amt }), memo, dimensions: m.dimensions.length ? m.dimensions : undefined },
        { accountId: m.assetAccountId, ...(offsetDebit ? { credit: amt } : { debit: amt }), memo }
      );
    }
    const description = g.voided
      ? `Void of ${g.label}: inventory cost`
      : g.initial
        ? `${g.sale ? "Cost of goods" : "Inventory cost"}: ${g.label}`
        : `Inventory cost adjustment: ${g.label}`;
    const r = await createAndPostJournal(
      { organizationId: org, actorId: ctx.actor.userId, actor: ctx.actor, journalDate: g.date, sourceCodeId: code, source: "inventory", description, lines },
      ctx.tx
    );
    if (!r.ok) throw new AppError("posting_failed", `Inventory cost entry for ${g.label}: ${r.error}`, { postingCode: r.code });
    for (const { m, diff } of g.rows) {
      await ctx.tx
        .update(inventoryMovements)
        .set({ bookedCost: sql`${inventoryMovements.bookedCost} + ${toDbMoney(diff)}`, updatedAt: sql`now()` })
        .where(eq(inventoryMovements.id, m.id));
      await ctx.tx.insert(inventoryCostPostings).values({ organizationId: org, movementId: m.id, journalId: r.journalId, amount: toDbMoney(diff), postedOn: g.date });
    }
  }
}

/** Quantity on hand, value, and unit cost of an item now (or as of a date). */
export async function stockOf(ctx: Ctx, itemId: string, asOf?: string): Promise<CostResult> {
  const org = ctx.actor.organizationId;
  const [item] = await ctx.tx.select({ purchaseCost: items.purchaseCost }).from(items).where(and(eq(items.id, itemId), eq(items.organizationId, org)));
  const ms = await ctx.tx
    .select()
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.organizationId, org), eq(inventoryMovements.itemId, itemId), asOf ? sql`${inventoryMovements.movementDate} <= ${asOf}::date` : undefined))
    .orderBy(asc(inventoryMovements.movementDate), asc(inventoryMovements.sequence));
  return computeCosts(ms, await costingMethod(ctx), money(item?.purchaseCost ?? 0));
}
