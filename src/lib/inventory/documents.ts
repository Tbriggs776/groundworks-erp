import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { items, type DimensionTag, type Item } from "@/lib/db/schema";
import type { Ctx } from "@/lib/actor";
import { AppError } from "@/lib/errors";
import { money, toDbMoney } from "@/lib/money";
import { amount, id } from "@/lib/schemas";
import { inventoryItems, recordMovements, type NewMovement } from "./engine";

/**
 * Where documents meet inventory. Purchase lines (bills, expenses,
 * checks) can name a product: an inventory item adds to stock at the
 * line's cost and posts to the item's asset account. Sales documents take
 * stock out (invoices, sales receipts) or put it back (credit memos,
 * refund receipts), costed by the engine against the item's COGS account.
 */

export const PurchaseLineItemFields = {
  itemId: id
    .optional()
    .nullable()
    .describe("A product bought. Fills the account (and cost) from the item. Inventory items add to stock and always post to the item's asset account."),
  quantity: amount.optional().nullable().describe("Units bought. Required for inventory items."),
  unitCost: amount.optional().nullable().describe("Cost per unit. With quantity, sets the line amount."),
};

type PurchaseLineIn = {
  accountId?: string | null;
  amount?: string | null;
  itemId?: string | null;
  quantity?: string | null;
  unitCost?: string | null;
};

export type ResolvedPurchaseLine = { accountId: string; amount: string; itemId: string | null; quantity: string | null; unitCost: string | null };

const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Fill each purchase line's account, amount, and unit cost from its item. */
export async function resolvePurchaseLines<T extends PurchaseLineIn>(
  ctx: Ctx,
  lines: T[],
  opts: { allowInventory: boolean; signed?: boolean }
): Promise<Array<Omit<T, keyof ResolvedPurchaseLine> & ResolvedPurchaseLine>> {
  const ids = lines.map((l) => l.itemId).filter((x): x is string => Boolean(x));
  const rows = ids.length
    ? await ctx.tx.select().from(items).where(and(eq(items.organizationId, ctx.actor.organizationId), inArray(items.id, ids)))
    : [];
  const byId = new Map<string, Item>(rows.map((r) => [r.id, r]));
  return lines.map((l, i) => {
    const n = `Line ${i + 1}`;
    const item = l.itemId ? byId.get(l.itemId) : undefined;
    if (l.itemId && !item) throw new AppError("not_found", `${n}: item not found.`);
    if (item && !item.isActive) throw new AppError("invalid_input", `${n}: ${item.name} is inactive.`);
    const qty = l.quantity ? money(l.quantity) : null;
    if (qty && qty.lte(0)) throw new AppError("invalid_input", `${n}: quantity must be greater than zero.`);
    const fromUnit = qty && l.unitCost ? cents(qty.times(money(l.unitCost))) : null;
    const amt = fromUnit ?? (l.amount ? money(l.amount) : null);
    if (!amt) throw new AppError("invalid_input", `${n}: enter an amount, or a quantity and unit cost.`);
    if (item?.type === "inventory") {
      if (!opts.allowInventory) throw new AppError("invalid_input", `${n}: ${item.name} is an inventory item; it can't go on this kind of transaction.`);
      if (!qty) throw new AppError("invalid_input", `${n}: ${item.name} is an inventory item; enter the quantity bought.`);
      if (!amt.gt(0)) throw new AppError("invalid_input", `${n}: an inventory line's amount must be greater than zero.`);
      if (!item.assetAccountId) throw new AppError("invalid_state", `${item.name} has no inventory asset account. Edit the item first.`);
      return {
        ...l,
        accountId: item.assetAccountId,
        amount: toDbMoney(amt),
        itemId: item.id,
        quantity: toDbMoney(qty),
        unitCost: toDbMoney(l.unitCost ? money(l.unitCost) : amt.div(qty)),
      };
    }
    if (!opts.signed && !amt.gt(0)) throw new AppError("invalid_input", `${n}: the amount must be greater than zero.`);
    const accountId = l.accountId ?? item?.expenseAccountId;
    if (!accountId) throw new AppError("invalid_input", `${n}: choose an account${item ? ` (${item.name} has no expense account)` : ""}.`);
    return {
      ...l,
      accountId,
      amount: toDbMoney(amt),
      itemId: item?.id ?? null,
      quantity: qty ? toDbMoney(qty) : null,
      unitCost: l.unitCost ? toDbMoney(l.unitCost) : null,
    };
  });
}

/** Stock bought on a posted purchase document. */
export async function recordPurchase(
  ctx: Ctx,
  doc: {
    sourceType: string;
    sourceId: string;
    label: string;
    date: string;
    exchangeRate: string;
    lines: Array<{ id: string; itemId: string | null; quantity: string | null; amount: string; dimensions?: DimensionTag[] }>;
  }
) {
  const inv = await inventoryItems(ctx, doc.lines.map((l) => l.itemId));
  const ms: NewMovement[] = [];
  for (const l of doc.lines) {
    const item = l.itemId ? inv.get(l.itemId) : undefined;
    if (!item || !l.quantity) continue;
    ms.push({
      itemId: item.id,
      date: doc.date,
      kind: "purchase",
      quantity: l.quantity,
      documentCost: toDbMoney(cents(money(l.amount).times(money(doc.exchangeRate)))),
      assetAccountId: item.assetAccountId!,
      sourceType: doc.sourceType,
      sourceId: doc.sourceId,
      sourceLineId: l.id,
      label: doc.label,
    });
  }
  await recordMovements(ctx, ms);
}

/** Stock sold (out) or returned (in) on a posted sales document. */
export async function recordSale(
  ctx: Ctx,
  doc: {
    direction: "sale" | "return";
    sourceType: string;
    sourceId: string;
    label: string;
    date: string;
    lines: Array<{ id?: string; itemId?: string | null; quantity?: string; dimensions: DimensionTag[] }>;
  }
) {
  const inv = await inventoryItems(ctx, doc.lines.map((l) => l.itemId));
  const ms: NewMovement[] = [];
  for (const l of doc.lines) {
    const item = l.itemId ? inv.get(l.itemId) : undefined;
    if (!item || !l.quantity || money(l.quantity).isZero()) continue;
    if (!item.assetAccountId || !item.expenseAccountId) {
      throw new AppError("invalid_state", `${item.name} needs an inventory asset account and a COGS account. Edit the item first.`);
    }
    const q = money(l.quantity);
    ms.push({
      itemId: item.id,
      date: doc.date,
      kind: doc.direction === "sale" ? "sale" : "return",
      quantity: toDbMoney(doc.direction === "sale" ? q.neg() : q),
      assetAccountId: item.assetAccountId,
      offsetAccountId: item.expenseAccountId,
      dimensions: l.dimensions,
      sourceType: doc.sourceType,
      sourceId: doc.sourceId,
      sourceLineId: l.id ?? null,
      label: doc.label,
    });
  }
  await recordMovements(ctx, ms);
}
