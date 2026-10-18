import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { itemType, items, type Item } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { notFound, rethrowUnique } from "@/lib/errors";
import { requireLineAccounts } from "@/lib/gl/lookups";
import {
  id,
  likePattern,
  nonNegativeAmount,
  optionalText,
  pagination,
  toPage,
  type Page,
} from "@/lib/schemas";

/**
 * PRODUCTS & SERVICES — what you sell (and optionally buy). An item
 * carries the default price and the income account an invoice line
 * credits, so a line can be as small as { itemId, quantity }.
 */

export const CreateItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: optionalText(64),
  type: z.enum(itemType.enumValues).optional().describe("service (default) or non_inventory."),
  description: optionalText(1000).describe("Default description printed on invoice lines."),
  salesPrice: nonNegativeAmount.optional().nullable().describe("Default unit price."),
  incomeAccountId: id.describe("Income account credited when sold, e.g. 4000 Sales or 4100 Services."),
  purchaseCost: nonNegativeAmount.optional().nullable(),
  expenseAccountId: id.optional().nullable().describe("Expense / COGS account when purchased."),
  isActive: z.boolean().optional(),
});
export type CreateItemInput = z.input<typeof CreateItemSchema>;

export const UpdateItemSchema = CreateItemSchema.partial().extend({ id });
export type UpdateItemInput = z.input<typeof UpdateItemSchema>;

export const ListItemsSchema = z.object({
  q: z.string().trim().optional().describe("Search name, SKU, or description."),
  includeInactive: z.coerce.boolean().optional(),
  ...pagination,
});

export async function listItems(
  ctx: Ctx,
  input: z.input<typeof ListItemsSchema> = {}
): Promise<Page<Item>> {
  requirePermission(ctx.actor, "read", "viewer", "list products and services");
  const f = ListItemsSchema.parse(input);
  const rows = await ctx.tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.organizationId, ctx.actor.organizationId),
        isNull(items.deletedAt),
        f.includeInactive ? undefined : eq(items.isActive, true),
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
  return toPage(rows, f.limit, f.offset);
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
  await requireLineAccounts(
    ctx.tx,
    org,
    [d.incomeAccountId, d.expenseAccountId].filter((x): x is string => !!x)
  );
  let row: Item;
  try {
    [row] = await ctx.tx
      .insert(items)
      .values({
        organizationId: org,
        name: d.name,
        sku: d.sku,
        type: d.type ?? "service",
        description: d.description,
        salesPrice: d.salesPrice ?? null,
        incomeAccountId: d.incomeAccountId,
        purchaseCost: d.purchaseCost ?? null,
        expenseAccountId: d.expenseAccountId ?? null,
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
      metadata: { name: row.name, salesPrice: row.salesPrice },
    },
    ctx.tx
  );
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
  let row: Item;
  try {
    [row] = await ctx.tx
      .update(items)
      .set({
        name: d.name ?? before.name,
        sku: d.sku !== undefined ? d.sku : before.sku,
        type: d.type ?? before.type,
        description: d.description !== undefined ? d.description : before.description,
        salesPrice: d.salesPrice !== undefined ? d.salesPrice : before.salesPrice,
        incomeAccountId: d.incomeAccountId ?? before.incomeAccountId,
        purchaseCost: d.purchaseCost !== undefined ? d.purchaseCost : before.purchaseCost,
        expenseAccountId:
          d.expenseAccountId !== undefined ? d.expenseAccountId : before.expenseAccountId,
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
