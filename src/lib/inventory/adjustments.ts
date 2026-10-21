import Decimal from "decimal.js";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  inventoryAdjustmentLines,
  inventoryAdjustments,
  inventoryCostPostings,
  inventoryMovements,
  items,
  type InventoryAdjustment,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { requireLineAccounts, sourceCodeId } from "@/lib/gl/lookups";
import { nextNumber } from "@/lib/gl/number-series";
import { createAndPostJournal, reverseJournal, type JournalLineInput } from "@/lib/gl/posting";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { amount, id, isoDate, likePattern, nonNegativeAmount, optionalText, type Page, pagination, toPage } from "@/lib/schemas";
import { costingMethod, inventoryItems, recordMovements, stockOf, voidMovements, type NewMovement } from "./engine";
import { checkLotNumbers, lotExpiresField, lotId, lotNumberField, requireLotNumber } from "./lots";

/**
 * INVENTORY ADJUSTMENTS: stock counted, damaged, lost, or found, and an
 * item's opening stock. Each line changes one item's quantity on hand.
 *
 *   stock added    at the cost per unit given (default: the item's current
 *                  unit cost); its own journal, Dr inventory / Cr offset
 *   stock removed  costed by the engine like a sale (FIFO or average);
 *                  Dr offset / Cr inventory
 *
 * Adjustments post when created. Voiding one reverses its journal and
 * takes its movements out, and every later sale of those items recosts.
 */

const LineSchema = z.object({
  itemId: id.describe("An inventory item."),
  quantity: amount
    .refine((v) => !money(v).isZero(), "A line's quantity can't be zero.")
    .describe("Change in quantity on hand: positive adds stock (found, counted over), negative removes it (damaged, lost, counted short)."),
  unitCost: nonNegativeAmount
    .optional()
    .describe("Stock added: cost per unit. Defaults to the item's current unit cost. Stock removed is costed by the company's costing method."),
  lotNumber: lotNumberField.describe(
    "Specific identification only (required then): the lot. Stock added may start a new lot; stock removed comes out of an existing one."
  ),
  lotExpiresOn: lotExpiresField,
});

export const CreateInventoryAdjustmentSchema = z.object({
  adjustmentDate: isoDate.describe("Date the stock changed. Later sales of these items recost."),
  offsetAccountId: id.describe(
    "The other side of the entry: an inventory shrinkage or cost of goods sold account for counts and damage, Opening Balance Equity for opening stock."
  ),
  memo: optionalText(500).describe("Why: the count, damage, theft, found stock."),
  lines: z.array(LineSchema).min(1, "Add at least one item.").max(500),
});
export type CreateInventoryAdjustmentInput = z.input<typeof CreateInventoryAdjustmentSchema>;

export const ListInventoryAdjustmentsSchema = z.object({
  q: z.string().trim().optional().describe("Search number or memo."),
  status: z.enum(["posted", "voided"]).optional(),
  ...pagination,
});

export const AdjustmentIdSchema = z.object({ id });
export const VoidAdjustmentSchema = z.object({ id, reason: z.string().trim().min(1, "A reason is required.").max(500) });

const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const KIND_LABEL: Record<string, string> = { opening: "Opening stock", adjustment: "Inventory adjustment" };
export const adjustmentLabel = (a: Pick<InventoryAdjustment, "kind" | "adjustmentNumber">) => `${KIND_LABEL[a.kind] ?? "Inventory adjustment"} ${a.adjustmentNumber}`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type AdjustmentListRow = InventoryAdjustment & { offsetAccountName: string; lineCount: number };

export async function listInventoryAdjustments(
  ctx: Ctx,
  input: z.input<typeof ListInventoryAdjustmentsSchema> = {}
): Promise<Page<AdjustmentListRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list inventory adjustments");
  const f = ListInventoryAdjustmentsSchema.parse(input);
  const rows = await ctx.tx
    .select({
      a: inventoryAdjustments,
      offsetAccountName: accounts.name,
      lineCount: sql<number>`(SELECT count(*)::int FROM inventory_adjustment_lines l WHERE l.adjustment_id = "inventory_adjustments"."id")`,
    })
    .from(inventoryAdjustments)
    .innerJoin(accounts, eq(accounts.id, inventoryAdjustments.offsetAccountId))
    .where(
      and(
        eq(inventoryAdjustments.organizationId, ctx.actor.organizationId),
        f.status ? eq(inventoryAdjustments.status, f.status) : undefined,
        f.q ? or(ilike(inventoryAdjustments.adjustmentNumber, likePattern(f.q)), ilike(inventoryAdjustments.memo, likePattern(f.q))) : undefined
      )
    )
    .orderBy(desc(inventoryAdjustments.adjustmentDate), desc(inventoryAdjustments.adjustmentNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.a, offsetAccountName: r.offsetAccountName, lineCount: r.lineCount })),
    f.limit,
    f.offset
  );
}

export type AdjustmentDetail = InventoryAdjustment & {
  label: string;
  offsetAccountName: string;
  lines: Array<{
    id: string;
    lineNumber: number;
    itemId: string;
    itemName: string;
    sku: string | null;
    quantity: string;
    unitCost: string | null;
    lotNumber: string | null;
    /** What the change is worth: + stock added, − stock removed. */
    value: string;
  }>;
  /** The journals behind it: stock added, then the cost of stock removed (and any recosts). */
  journalIds: string[];
};

export async function getInventoryAdjustment(ctx: Ctx, input: { id: string }): Promise<AdjustmentDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view inventory adjustments");
  const { id: adjustmentId } = AdjustmentIdSchema.parse(input);
  const a = await loadAdjustment(ctx, adjustmentId);
  const [offset] = await ctx.tx.select({ name: accounts.name, code: accounts.code }).from(accounts).where(eq(accounts.id, a.offsetAccountId));
  const lines = await ctx.tx
    .select({ l: inventoryAdjustmentLines, itemName: items.name, sku: items.sku, cost: inventoryMovements.cost })
    .from(inventoryAdjustmentLines)
    .innerJoin(items, eq(items.id, inventoryAdjustmentLines.itemId))
    .leftJoin(
      inventoryMovements,
      and(eq(inventoryMovements.sourceType, "inventory_adjustment"), eq(inventoryMovements.sourceLineId, inventoryAdjustmentLines.id))
    )
    .where(eq(inventoryAdjustmentLines.adjustmentId, a.id))
    .orderBy(asc(inventoryAdjustmentLines.lineNumber));
  const posted = await ctx.tx
    .selectDistinct({ journalId: inventoryCostPostings.journalId })
    .from(inventoryCostPostings)
    .innerJoin(inventoryMovements, eq(inventoryMovements.id, inventoryCostPostings.movementId))
    .where(and(eq(inventoryMovements.organizationId, a.organizationId), eq(inventoryMovements.sourceType, "inventory_adjustment"), eq(inventoryMovements.sourceId, a.id)));
  const journalIds = [a.glJournalId, ...posted.map((p) => p.journalId), a.voidGlJournalId].filter((x): x is string => Boolean(x));
  return {
    ...a,
    label: adjustmentLabel(a),
    offsetAccountName: offset ? `${offset.code} ${offset.name}` : "",
    lines: lines.map(({ l, itemName, sku, cost }) => {
      const q = money(l.quantity);
      // A voided line's movement costs nothing now; show what it was entered at.
      const v = q.gt(0) ? cents(q.times(money(l.unitCost ?? 0))) : money(cost ?? 0).neg();
      return { id: l.id, lineNumber: l.lineNumber, itemId: l.itemId, itemName, sku, quantity: l.quantity, unitCost: l.unitCost, lotNumber: l.lotNumber, value: toDbMoney(v) };
    }),
    journalIds: [...new Set(journalIds)],
  };
}

async function loadAdjustment(ctx: Ctx, adjustmentId: string, forUpdate = false): Promise<InventoryAdjustment> {
  const q = ctx.tx
    .select()
    .from(inventoryAdjustments)
    .where(and(eq(inventoryAdjustments.id, adjustmentId), eq(inventoryAdjustments.organizationId, ctx.actor.organizationId)));
  const [a] = forUpdate ? await q.for("update") : await q;
  if (!a) throw notFound("Inventory adjustment");
  return a;
}

// ---------------------------------------------------------------------------
// Create (posts) and void
// ---------------------------------------------------------------------------

/** `kind: "opening"` is for an item's opening stock (see createItem). */
export async function createInventoryAdjustment(
  ctx: Ctx,
  input: CreateInventoryAdjustmentInput,
  opts: { kind?: "adjustment" | "opening" } = {}
): Promise<AdjustmentDetail> {
  requirePermission(ctx.actor, "post", "bookkeeper", "adjust inventory");
  const d = CreateInventoryAdjustmentSchema.parse(input);
  const org = ctx.actor.organizationId;
  const kind = opts.kind ?? "adjustment";

  const [offset] = (await requireLineAccounts(ctx.tx, org, [d.offsetAccountId])).values();
  if (offset.subcategory === "inventory") {
    throw new AppError("invalid_input", "The offset can't be an inventory asset account; pick shrinkage, cost of goods sold, or equity.");
  }
  const inv = await inventoryItems(ctx, d.lines.map((l) => l.itemId));
  await checkLotNumbers(ctx, d.lines, inv, { mustExist: false });
  const lots = (await costingMethod(ctx)) === "specific";
  const lines = [];
  for (const [i, l] of d.lines.entries()) {
    const item = inv.get(l.itemId);
    if (!item) throw new AppError("invalid_input", `Line ${i + 1}: that's not an inventory item.`);
    if (!item.isActive) throw new AppError("invalid_input", `Line ${i + 1}: ${item.name} is inactive.`);
    if (!item.assetAccountId) throw new AppError("invalid_state", `${item.name} has no inventory asset account. Edit the item first.`);
    const q = money(l.quantity);
    // Lots: stock added may start one; stock removed comes out of one that exists.
    const lot = lots
      ? await lotId(ctx, item, requireLotNumber(l.lotNumber, item, `Line ${i + 1}`), {
          label: `Line ${i + 1}`,
          ...(q.gt(0) ? { create: { expiresOn: l.lotExpiresOn } } : {}),
        })
      : null;
    // Stock removed is costed later by the engine; the current unit cost estimates it for limits.
    const current = l.unitCost === undefined || q.lt(0) ? (await stockOf(ctx, item.id, d.adjustmentDate)).unitCost : null;
    const unit = l.unitCost !== undefined ? money(l.unitCost) : (current ?? money(item.purchaseCost ?? 0));
    lines.push({ item, q, unit, value: cents(q.abs().times(unit)), lot, lotNumber: lots ? l.lotNumber! : null, lotExpiresOn: lots && q.gt(0) ? (l.lotExpiresOn ?? null) : null });
  }
  requirePostingWithinLimit(ctx.actor, sumMoney(lines.map((l) => l.value)), `${KIND_LABEL[kind]} of ${lines.length} item${lines.length === 1 ? "" : "s"}`);

  const adjustmentNumber = await nextNumber(ctx.tx, org, "IA");
  const [a] = await ctx.tx
    .insert(inventoryAdjustments)
    .values({
      organizationId: org,
      adjustmentNumber,
      adjustmentDate: d.adjustmentDate,
      kind,
      offsetAccountId: offset.id,
      memo: d.memo,
      status: "posted",
      ...creatorFields(ctx.actor),
    })
    .returning();
  const rows = await ctx.tx
    .insert(inventoryAdjustmentLines)
    .values(
      lines.map((l, i) => ({
        organizationId: org,
        adjustmentId: a.id,
        lineNumber: i + 1,
        itemId: l.item.id,
        quantity: toDbMoney(l.q),
        unitCost: l.q.gt(0) ? toDbMoney(l.unit) : null,
        lotNumber: l.lotNumber,
        lotExpiresOn: l.lotExpiresOn,
      }))
    )
    .returning();
  const label = adjustmentLabel(a);

  // Stock added: Dr each item's asset account, Cr the offset.
  const ins = lines.map((l, i) => ({ ...l, row: rows[i] })).filter((l) => l.q.gt(0));
  let glJournalId: string | null = null;
  const addedTotal = sumMoney(ins.map((l) => l.value));
  if (addedTotal.gt(0)) {
    const je: JournalLineInput[] = ins
      .filter((l) => l.value.gt(0))
      .map((l) => ({ accountId: l.item.assetAccountId!, debit: toDbMoney(l.value), memo: `${l.item.name} × ${l.q.toString()}` }));
    je.push({ accountId: offset.id, credit: toDbMoney(addedTotal), memo: d.memo ?? label });
    const r = await createAndPostJournal(
      {
        organizationId: org,
        actorId: ctx.actor.userId,
        actor: ctx.actor,
        journalDate: d.adjustmentDate,
        sourceCodeId: await sourceCodeId(ctx.tx, org, "INV"),
        source: "inventory",
        description: d.memo ? `${label} · ${d.memo}` : label,
        documentNo: adjustmentNumber,
        lines: je,
      },
      ctx.tx
    );
    if (!r.ok) throw new AppError("posting_failed", r.error, { postingCode: r.code, ...r.meta });
    glJournalId = r.journalId;
    await ctx.tx.update(inventoryAdjustments).set({ glJournalId }).where(eq(inventoryAdjustments.id, a.id));
  }

  const movements: NewMovement[] = lines.map((l, i) => ({
    lotId: l.lot,
    itemId: l.item.id,
    date: d.adjustmentDate,
    kind: kind === "opening" ? "opening" : "adjustment",
    quantity: toDbMoney(l.q),
    ...(l.q.gt(0) ? { documentCost: toDbMoney(l.value) } : { offsetAccountId: offset.id }),
    assetAccountId: l.item.assetAccountId!,
    sourceType: "inventory_adjustment",
    sourceId: a.id,
    sourceLineId: rows[i].id,
    label,
  }));
  await recordMovements(ctx, movements);

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "inventory.adjustment.created",
      entityType: "inventory_adjustment",
      entityId: a.id,
      metadata: {
        adjustmentNumber,
        kind,
        date: d.adjustmentDate,
        offsetAccountId: offset.id,
        lines: lines.map((l) => ({ itemId: l.item.id, quantity: toDbMoney(l.q) })),
        journalId: glJournalId,
      },
    },
    ctx.tx
  );
  return getInventoryAdjustment(ctx, { id: a.id });
}

export async function voidInventoryAdjustment(ctx: Ctx, input: z.input<typeof VoidAdjustmentSchema>): Promise<AdjustmentDetail> {
  requirePermission(ctx.actor, "post", "admin", "void inventory adjustments");
  const { id: adjustmentId, reason } = VoidAdjustmentSchema.parse(input);
  const a = await loadAdjustment(ctx, adjustmentId, true);
  if (a.status !== "posted") throw invalidState(`${adjustmentLabel(a)} is already voided.`);
  let voidGlJournalId: string | null = null;
  if (a.glJournalId) {
    const r = await reverseJournal(
      a.glJournalId,
      { actorId: ctx.actor.userId, actor: ctx.actor, organizationId: a.organizationId, description: `Void of ${adjustmentLabel(a).toLowerCase()}: ${reason}` },
      ctx.tx
    );
    if (!r.ok) throw new AppError("posting_failed", `GL reversal failed: ${r.error}`, { postingCode: r.code });
    voidGlJournalId = r.journalId;
  }
  await voidMovements(ctx, "inventory_adjustment", a.id);
  await ctx.tx
    .update(inventoryAdjustments)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId, updatedAt: sql`now()` })
    .where(eq(inventoryAdjustments.id, a.id));
  await writeAudit(
    {
      organizationId: a.organizationId,
      ...auditFields(ctx.actor),
      event: "inventory.adjustment.voided",
      entityType: "inventory_adjustment",
      entityId: a.id,
      metadata: { adjustmentNumber: a.adjustmentNumber, reason, reversalJournalId: voidGlJournalId },
    },
    ctx.tx
  );
  return getInventoryAdjustment(ctx, { id: a.id });
}
