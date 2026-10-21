import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { inventoryLots, type Item } from "@/lib/db/schema";
import { requirePermission, type Ctx } from "@/lib/actor";
import { AppError } from "@/lib/errors";
import { flag, id, isoDate } from "@/lib/schemas";
import { costingMethod } from "./engine";

/**
 * LOTS, for companies that cost by specific identification. A lot is an
 * item's lot number, with an optional expiration date. Stock coming in
 * (bills, expenses, checks, adjustments up) starts a lot or adds to one;
 * stock going out or coming back (sales, returns, vendor credits,
 * adjustments down) names a lot that already exists. Lines carry the lot
 * number; the lot itself is made when stock first comes in, so drafts
 * never leave empty lots behind.
 */

export const lotNumberField = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .optional()
  .nullable()
  .describe("Specific identification only: the lot this line moves. Required on inventory items' lines to post.");
export const lotExpiresField = isoDate.optional().nullable().describe("Specific identification only: when a lot bought on this line expires.");

/** Lot numbers on lines before a document is saved: only with specific identification, only on inventory items. */
export async function checkLotNumbers(
  ctx: Ctx,
  lines: Array<{ lotNumber?: string | null; itemId?: string | null }>,
  items: Map<string, Pick<Item, "id" | "name" | "type">>,
  opts: { mustExist: boolean }
) {
  const named = lines.map((l, i) => ({ ...l, n: i + 1 })).filter((l) => l.lotNumber);
  if (named.length === 0) return;
  if ((await costingMethod(ctx)) !== "specific") {
    throw new AppError("invalid_input", "Lot numbers are for companies that cost inventory by specific identification (Settings → Inventory).");
  }
  for (const l of named) {
    const item = l.itemId ? items.get(l.itemId) : undefined;
    if (item?.type !== "inventory") throw new AppError("invalid_input", `Line ${l.n}: only inventory items take a lot number.`);
    if (opts.mustExist) await lotId(ctx, item, l.lotNumber!, { label: `Line ${l.n}` });
  }
}

/**
 * The lot's id. `create` starts it when it's new (stock coming in), and
 * sets its expiration if it had none; otherwise the lot must exist.
 */
export async function lotId(
  ctx: Ctx,
  item: Pick<Item, "id" | "name">,
  lotNumber: string,
  opts: { label: string; create?: { expiresOn?: string | null } }
): Promise<string> {
  const org = ctx.actor.organizationId;
  const where = and(eq(inventoryLots.organizationId, org), eq(inventoryLots.itemId, item.id), eq(inventoryLots.lotNumber, lotNumber));
  const [lot] = await ctx.tx.select().from(inventoryLots).where(where);
  if (lot) {
    const expiresOn = opts.create?.expiresOn;
    if (expiresOn && !lot.expiresOn) {
      await ctx.tx.update(inventoryLots).set({ expiresOn, updatedAt: sql`now()` }).where(eq(inventoryLots.id, lot.id));
    }
    return lot.id;
  }
  if (!opts.create) throw new AppError("invalid_input", `${opts.label}: ${item.name} has no lot ${lotNumber}.`);
  await ctx.tx
    .insert(inventoryLots)
    .values({ organizationId: org, itemId: item.id, lotNumber, expiresOn: opts.create.expiresOn ?? null })
    .onConflictDoNothing();
  const [made] = await ctx.tx.select({ id: inventoryLots.id }).from(inventoryLots).where(where);
  return made.id;
}

/** Posting a line of a lot-costed item: the lot is required. */
export function requireLotNumber(lotNumber: string | null | undefined, item: Pick<Item, "name">, label: string): string {
  if (!lotNumber) throw new AppError("invalid_input", `${label}: choose a lot for ${item.name} (this company costs inventory by specific identification).`);
  return lotNumber;
}

export const ListLotsSchema = z.object({
  itemId: id.optional(),
  inStock: flag.optional().describe("Only lots with stock on hand (or short)."),
});

export type LotRow = {
  id: string;
  itemId: string;
  itemName: string;
  lotNumber: string;
  expiresOn: string | null;
  onHand: string;
  value: string;
};

/** Lots with what's on hand in each, by item, soonest to expire first. */
export async function listLots(ctx: Ctx, input: z.input<typeof ListLotsSchema> = {}): Promise<LotRow[]> {
  requirePermission(ctx.actor, "read", "viewer", "list lots");
  const f = ListLotsSchema.parse(input);
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<{ id: string; item_id: string; item_name: string; lot_number: string; expires_on: string | null; on_hand: string; value: string }>(sql`
    SELECT l.id, l.item_id, i.name AS item_name, l.lot_number, l.expires_on::text,
           COALESCE(SUM(m.quantity) FILTER (WHERE m.voided_at IS NULL), 0)::text AS on_hand,
           COALESCE(SUM(CASE WHEN m.quantity > 0 THEN m.cost ELSE -m.cost END) FILTER (WHERE m.voided_at IS NULL), 0)::text AS value
      FROM inventory_lots l
      JOIN items i ON i.id = l.item_id
      LEFT JOIN inventory_movements m ON m.lot_id = l.id
     WHERE l.organization_id = ${org} ${f.itemId ? sql`AND l.item_id = ${f.itemId}` : sql``}
     GROUP BY l.id, i.name
    ${f.inStock ? sql`HAVING COALESCE(SUM(m.quantity) FILTER (WHERE m.voided_at IS NULL), 0) <> 0` : sql``}
     ORDER BY i.name, l.expires_on NULLS LAST, l.lot_number
  `);
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    lotNumber: r.lot_number,
    expiresOn: r.expires_on,
    onHand: r.on_hand,
    value: r.value,
  }));
}

/** Lots by id, for labels. */
export async function lotNumbers(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ id: inventoryLots.id, lotNumber: inventoryLots.lotNumber })
    .from(inventoryLots)
    .where(and(eq(inventoryLots.organizationId, ctx.actor.organizationId), inArray(inventoryLots.id, ids)));
  return new Map(rows.map((r) => [r.id, r.lotNumber]));
}
