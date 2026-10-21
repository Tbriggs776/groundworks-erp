import Decimal from "decimal.js";
import type { Item } from "@/lib/db/schema";
import { money } from "@/lib/money";

/**
 * Products on purchase lines (bills, expenses, checks): choosing one fills
 * the account and cost, quantity × rate fills the amount. Inventory items
 * always post to their asset account (the server enforces it too).
 */

export type PurchaseItem = Pick<Item, "id" | "name" | "sku" | "type" | "description" | "purchaseCost" | "expenseAccountId" | "assetAccountId">;

export const toPurchaseItems = (rows: Item[]): PurchaseItem[] =>
  rows.map(({ id, name, sku, type, description, purchaseCost, expenseAccountId, assetAccountId }) => ({
    id,
    name,
    sku,
    type,
    description,
    purchaseCost,
    expenseAccountId,
    assetAccountId,
  }));

export type ItemLineFields = { itemId: string; quantity: string; unitCost: string; amount: string; accountId: string; description: string };

const num = (v: string) => {
  try {
    return v.trim() ? money(v) : null;
  } catch {
    return null;
  }
};
const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Quantity × rate, when both are numbers. */
export function lineTotal(quantity: string, unitCost: string): string | null {
  const q = num(quantity);
  const r = num(unitCost);
  return q && r ? cents(q.times(r)).toFixed(2) : null;
}

/** Apply an edit to a line: picking a product fills the rest, quantity or rate refills the amount. */
export function editItemLine<L extends ItemLineFields>(line: L, patch: Partial<ItemLineFields>, items: PurchaseItem[]): L {
  const next = { ...line, ...patch };
  if (patch.itemId !== undefined) {
    const item = items.find((i) => i.id === patch.itemId);
    if (item) {
      next.accountId = (item.type === "inventory" ? item.assetAccountId : item.expenseAccountId) ?? next.accountId;
      next.unitCost = item.purchaseCost ? money(item.purchaseCost).toString() : next.unitCost;
      next.quantity = next.quantity || "1";
      next.description = next.description || item.description || item.name;
    }
  }
  if (patch.itemId !== undefined || patch.quantity !== undefined || patch.unitCost !== undefined) {
    next.amount = lineTotal(next.quantity, next.unitCost) ?? next.amount;
  }
  return next;
}

export const isInventory = (items: PurchaseItem[], itemId: string) => items.find((i) => i.id === itemId)?.type === "inventory";

/** The item fields to send: a rate only when it still explains the amount. */
export function itemPayload(line: ItemLineFields) {
  if (!line.itemId) return {};
  const fromRate = lineTotal(line.quantity, line.unitCost);
  return {
    itemId: line.itemId,
    quantity: line.quantity || undefined,
    unitCost: fromRate && money(fromRate).eq(money(line.amount || "0")) ? line.unitCost : undefined,
  };
}
