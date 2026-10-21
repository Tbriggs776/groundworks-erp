import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { accounts, inventoryMovements, itemType, items, type Item } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, notFound, rethrowUnique } from "@/lib/errors";
import { accountByCode, requireLineAccounts } from "@/lib/gl/lookups";
import { createInventoryAdjustment } from "@/lib/inventory/adjustments";
import { lotExpiresField, lotNumberField } from "@/lib/inventory/lots";
import {
  flag,
  id,
  isoDate,
  likePattern,
  nonNegativeAmount,
  optionalText,
  type Page,
  pagination,
  positiveAmount,
  toPage,
} from "@/lib/schemas";

/**
 * PRODUCTS & SERVICES — what you sell (and optionally buy). An item
 * carries the default price and the income account an invoice line
 * credits, so a line can be as small as { itemId, quantity }.
 *
 * Inventory items also track stock (see src/lib/inventory): bills and
 * expenses add it at cost into the item's asset account, sales take it
 * out and post cost of goods sold.
 */

const ItemFields = {
  name: z.string().trim().min(1).max(200),
  sku: optionalText(64),
  type: z
    .enum(itemType.enumValues)
    .optional()
    .describe("service (default), non_inventory, or inventory (tracks quantity on hand; sales post cost of goods sold)."),
  description: optionalText(1000).describe("Default description printed on invoice lines."),
  salesPrice: nonNegativeAmount.optional().nullable().describe("Default unit price."),
  incomeAccountId: id.describe("Income account credited when sold, e.g. 4000 Sales or 4100 Services."),
  purchaseCost: nonNegativeAmount.optional().nullable().describe("Default cost per unit when bought."),
  expenseAccountId: id
    .optional()
    .nullable()
    .describe("Expense account when bought. Inventory items: the cost of goods sold account debited when sold (default: the first materials COGS account, 5050 Cost of Goods Sold on new companies)."),
  assetAccountId: id
    .optional()
    .nullable()
    .describe("Inventory items: the inventory asset account their stock sits in (default: the Inventory Asset account). Fixed once the item has stock movements."),
  reorderPoint: nonNegativeAmount.optional().nullable().describe("Inventory items: reorder when quantity on hand falls to this."),
  taxable: z.boolean().optional().describe("Charge sales tax when sold (default true). Lines can override."),
  isActive: z.boolean().optional(),
};

export const CreateItemSchema = z.object({
  ...ItemFields,
  openingStock: z
    .object({
      quantity: positiveAmount.describe("Quantity on hand."),
      unitCost: nonNegativeAmount.optional().describe("Cost per unit. Defaults to purchaseCost."),
      asOf: isoDate.describe("Date the quantity was on hand. Sales before it can't draw on it."),
      offsetAccountId: id.optional().describe("Credited for the stock's value. Default 3300 Opening Balance Equity."),
      lotNumber: lotNumberField.describe("Specific identification only (required then): the lot the opening stock is in."),
      lotExpiresOn: lotExpiresField,
    })
    .optional()
    .describe("Inventory items: stock on hand when you start tracking. Posts an opening stock adjustment (needs the post scope)."),
});
export type CreateItemInput = z.input<typeof CreateItemSchema>;

export const UpdateItemSchema = z.object(ItemFields).partial().extend({ id });
export type UpdateItemInput = z.input<typeof UpdateItemSchema>;

export const ListItemsSchema = z.object({
  q: z.string().trim().optional().describe("Search name, SKU, or description."),
  includeInactive: flag.optional(),
  type: z.enum(itemType.enumValues).optional(),
  ...pagination,
});

/** Inventory items add quantity on hand and stock value (null for the rest). */
export type ItemRow = Item & { onHand: string | null; stockValue: string | null };

export async function listItems(
  ctx: Ctx,
  input: z.input<typeof ListItemsSchema> = {}
): Promise<Page<ItemRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list products and services");
  const f = ListItemsSchema.parse(input);
  const rows = await ctx.tx
    .select({ item: items, onHand: onHandSql, stockValue: stockValueSql })
    .from(items)
    .where(
      and(
        eq(items.organizationId, ctx.actor.organizationId),
        isNull(items.deletedAt),
        f.includeInactive ? undefined : eq(items.isActive, true),
        f.type ? eq(items.type, f.type) : undefined,
        f.q
          ? or(
              ilike(items.name, likePattern(f.q)),
              ilike(items.sku, likePattern(f.q)),
              ilike(items.description, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(asc(items.name))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.item, onHand: r.onHand, stockValue: r.stockValue })),
    f.limit,
    f.offset
  );
}

// Every movement's cost is kept current by the engine, so value on hand is
// what came in less what went out.
const onHandSql = sql<string | null>`CASE WHEN "items"."type" = 'inventory' THEN (
  SELECT COALESCE(SUM(m.quantity), 0) FROM inventory_movements m WHERE m.item_id = "items"."id" AND m.voided_at IS NULL
)::text END`;
const stockValueSql = sql<string | null>`CASE WHEN "items"."type" = 'inventory' THEN (
  SELECT COALESCE(SUM(CASE WHEN m.quantity > 0 THEN m.cost ELSE -m.cost END), 0) FROM inventory_movements m WHERE m.item_id = "items"."id" AND m.voided_at IS NULL
)::text END`;

/** Inventory items need an inventory asset account and a cost of goods sold account. */
async function inventoryAccounts(
  ctx: Ctx,
  d: { assetAccountId?: string | null; expenseAccountId?: string | null }
): Promise<{ assetAccountId: string; expenseAccountId: string }> {
  const org = ctx.actor.organizationId;
  const pick = async (where: SQL) => {
    const [a] = await ctx.tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, org), eq(accounts.isActive, true), eq(accounts.accountType, "posting"), where))
      .orderBy(asc(accounts.code))
      .limit(1);
    return a?.id;
  };
  const assetAccountId = d.assetAccountId ?? (await pick(eq(accounts.subcategory, "inventory")));
  if (!assetAccountId) throw new AppError("invalid_input", "Choose an inventory asset account for this item.");
  // 5050 Cost of Goods Sold on new companies; older ones have 5100 Supplies & Materials.
  const expenseAccountId = d.expenseAccountId ?? (await pick(eq(accounts.subcategory, "cogs_materials")));
  if (!expenseAccountId) throw new AppError("invalid_input", "Choose a cost of goods sold account for this item.");
  const found = await requireLineAccounts(ctx.tx, org, [assetAccountId, expenseAccountId]);
  if (found.get(assetAccountId)?.subcategory !== "inventory") {
    throw new AppError("invalid_input", "An inventory item's asset account must be an inventory account (like 1300 Inventory Asset).");
  }
  const cogs = found.get(expenseAccountId);
  if (cogs?.category !== "income_statement" || cogs.subcategory === "operating_revenue" || cogs.subcategory === "other_revenue") {
    throw new AppError("invalid_input", "An inventory item's cost of goods sold account must be a cost or expense account.");
  }
  return { assetAccountId, expenseAccountId };
}

async function hasMovements(ctx: Ctx, itemId: string): Promise<boolean> {
  const [m] = await ctx.tx
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.organizationId, ctx.actor.organizationId), eq(inventoryMovements.itemId, itemId)))
    .limit(1);
  return Boolean(m);
}

export async function getItem(ctx: Ctx, input: { id: string }): Promise<Item> {
  requirePermission(ctx.actor, "read", "viewer", "view products and services");
  const itemId = id.parse(input.id);
  const [row] = await ctx.tx
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.organizationId, ctx.actor.organizationId)));
  if (!row) throw notFound("Item");
  return row;
}

export async function createItem(ctx: Ctx, input: CreateItemInput): Promise<Item> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create products and services");
  const d = CreateItemSchema.parse(input);
  const org = ctx.actor.organizationId;
  const type = d.type ?? "service";
  await requireLineAccounts(
    ctx.tx,
    org,
    [d.incomeAccountId, d.expenseAccountId].filter((x): x is string => !!x)
  );
  const stock = type === "inventory" ? await inventoryAccounts(ctx, d) : null;
  if (d.openingStock && !stock) throw new AppError("invalid_input", "Only inventory items take opening stock.");
  let row: Item;
  try {
    [row] = await ctx.tx
      .insert(items)
      .values({
        organizationId: org,
        name: d.name,
        sku: d.sku,
        type,
        description: d.description,
        salesPrice: d.salesPrice ?? null,
        incomeAccountId: d.incomeAccountId,
        purchaseCost: d.purchaseCost ?? null,
        expenseAccountId: stock?.expenseAccountId ?? d.expenseAccountId ?? null,
        assetAccountId: stock?.assetAccountId ?? null,
        reorderPoint: stock ? (d.reorderPoint ?? null) : null,
        taxable: d.taxable ?? true,
        isActive: d.isActive ?? true,
      })
      .returning();
  } catch (err) {
    rethrowUnique(err, `A product or service named "${d.name}" already exists.`);
  }
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "item.created",
      entityType: "item",
      entityId: row.id,
      metadata: { name: row.name, type: row.type, salesPrice: row.salesPrice },
    },
    ctx.tx
  );
  if (d.openingStock) {
    const o = d.openingStock;
    const unitCost = o.unitCost ?? row.purchaseCost;
    if (unitCost === null) throw new AppError("invalid_input", "Enter the opening stock's unit cost (or the item's purchase cost).");
    const offset = o.offsetAccountId ?? (await accountByCode(ctx.tx, org, "3300", "opening stock")).id;
    await createInventoryAdjustment(
      ctx,
      { adjustmentDate: o.asOf, offsetAccountId: offset, memo: `Opening stock: ${row.name}`, lines: [{ itemId: row.id, quantity: o.quantity, unitCost, lotNumber: o.lotNumber, lotExpiresOn: o.lotExpiresOn }] },
      { kind: "opening" }
    );
  }
  return row;
}

export async function updateItem(ctx: Ctx, input: UpdateItemInput): Promise<Item> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit products and services");
  const d = UpdateItemSchema.parse(input);
  const before = await getItem(ctx, { id: d.id });
  await requireLineAccounts(
    ctx.tx,
    ctx.actor.organizationId,
    [d.incomeAccountId, d.expenseAccountId].filter((x): x is string => !!x)
  );
  const type = d.type ?? before.type;
  const moved = before.type === "inventory" && (await hasMovements(ctx, before.id));
  if (moved && type !== "inventory") {
    throw new AppError("invalid_state", `${before.name} has stock movements; it stays an inventory item. Make it inactive instead.`);
  }
  const stock =
    type === "inventory"
      ? await inventoryAccounts(ctx, {
          assetAccountId: d.assetAccountId !== undefined ? d.assetAccountId : before.assetAccountId,
          expenseAccountId: d.expenseAccountId !== undefined ? d.expenseAccountId : before.expenseAccountId,
        })
      : null;
  if (moved && stock && stock.assetAccountId !== before.assetAccountId) {
    throw new AppError("invalid_state", `${before.name} has stock movements; its inventory asset account can't change.`);
  }
  let row: Item;
  try {
    [row] = await ctx.tx
      .update(items)
      .set({
        name: d.name ?? before.name,
        sku: d.sku !== undefined ? d.sku : before.sku,
        type,
        description: d.description !== undefined ? d.description : before.description,
        salesPrice: d.salesPrice !== undefined ? d.salesPrice : before.salesPrice,
        incomeAccountId: d.incomeAccountId ?? before.incomeAccountId,
        purchaseCost: d.purchaseCost !== undefined ? d.purchaseCost : before.purchaseCost,
        expenseAccountId:
          stock?.expenseAccountId ?? (d.expenseAccountId !== undefined ? d.expenseAccountId : before.expenseAccountId),
        assetAccountId: stock?.assetAccountId ?? null,
        reorderPoint: stock ? (d.reorderPoint !== undefined ? d.reorderPoint : before.reorderPoint) : null,
        taxable: d.taxable ?? before.taxable,
        isActive: d.isActive ?? before.isActive,
        updatedAt: sql`now()`,
      })
      .where(eq(items.id, before.id))
      .returning();
  } catch (err) {
    rethrowUnique(err, `A product or service named "${d.name}" already exists.`);
  }
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "item.updated",
      entityType: "item",
      entityId: row.id,
      metadata: { name: row.name, changed: Object.keys(d).filter((k) => k !== "id") },
    },
    ctx.tx
  );
  return row;
}
