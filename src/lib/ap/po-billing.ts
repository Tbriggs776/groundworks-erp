import type Decimal from "decimal.js";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { apBillLines, apBills, purchaseOrderLines, purchaseOrders, type PurchaseOrder, type PurchaseOrderLine } from "@/lib/db/schema";
import { auditFields, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { money } from "@/lib/money";

/**
 * Billing a purchase order in parts: how much of each PO line the bills
 * have taken.
 *
 * A bill line bills a PO line when it points at it
 * (`ap_bill_lines.purchase_order_line_id`). Billed = Σ those bill lines on
 * bills that aren't voided (drafts count: they hold their share until
 * deleted). Remaining = PO line amount − billed.
 */

export async function loadPurchaseOrder(ctx: Ctx, poId: string, lock = false): Promise<PurchaseOrder> {
  const q = ctx.tx
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.organizationId, ctx.actor.organizationId), isNull(purchaseOrders.deletedAt)));
  const [po] = lock ? await q.for("update") : await q;
  if (!po) throw notFound("Purchase order");
  return po;
}

export async function linesOfPurchaseOrder(ctx: Ctx, poId: string): Promise<PurchaseOrderLine[]> {
  return ctx.tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId)).orderBy(asc(purchaseOrderLines.lineNumber));
}

/** Billed so far per PO line, optionally leaving one bill out (the one being edited). */
export async function billedByPoLine(ctx: Ctx, poId: string, excludeBillId?: string): Promise<Map<string, Decimal>> {
  const rows = await ctx.tx
    .select({ lineId: apBillLines.purchaseOrderLineId, billed: sql<string>`SUM(${apBillLines.amount})::text` })
    .from(apBillLines)
    .innerJoin(apBills, eq(apBills.id, apBillLines.billId))
    .where(
      and(
        eq(apBills.organizationId, ctx.actor.organizationId),
        eq(apBills.purchaseOrderId, poId),
        ne(apBills.status, "voided"),
        isNull(apBills.deletedAt),
        excludeBillId ? ne(apBills.id, excludeBillId) : undefined
      )
    )
    .groupBy(apBillLines.purchaseOrderLineId);
  return new Map(rows.filter((r) => r.lineId).map((r) => [r.lineId as string, money(r.billed)]));
}

export function poRemainingOf(line: Pick<PurchaseOrderLine, "amount">, billed: Decimal | undefined): Decimal {
  return money(line.amount).minus(billed ?? 0);
}

/**
 * Quantity billed (received) so far per PO line: the bill lines' own
 * quantities (older bill lines without one count their share by amount).
 */
export async function billedQtyByPoLine(ctx: Ctx, poId: string): Promise<Map<string, Decimal>> {
  const rows = await ctx.tx.execute<{ line_id: string; qty: string }>(sql`
    SELECT bl.purchase_order_line_id AS line_id,
           SUM(COALESCE(bl.quantity, pl.quantity * bl.amount / NULLIF(pl.amount, 0)))::text AS qty
      FROM ap_bill_lines bl
      JOIN ap_bills b ON b.id = bl.bill_id
      JOIN purchase_order_lines pl ON pl.id = bl.purchase_order_line_id
     WHERE b.organization_id = ${ctx.actor.organizationId} AND b.purchase_order_id = ${poId}
       AND b.status <> 'voided' AND b.deleted_at IS NULL
     GROUP BY 1
  `);
  return new Map(rows.map((r) => [r.line_id, money(r.qty).toDecimalPlaces(4)]));
}

/** The share of a PO line's quantity an amount of it bills, to 4 places. */
export function quantityForAmount(line: Pick<PurchaseOrderLine, "amount" | "quantity">, billed: Decimal | undefined): Decimal {
  const amt = money(line.amount);
  if (!billed || amt.isZero()) return money(0);
  return money(line.quantity).times(billed).div(amt).toDecimalPlaces(4);
}

/**
 * Check a bill's PO links before it's saved: the PO must be the bill
 * vendor's and billable, the lines must be on it, and no PO line may be
 * billed past its amount. Returns the PO (locked) or null.
 */
export async function checkPurchaseOrderBilling(
  ctx: Ctx,
  opts: {
    purchaseOrderId: string | null;
    vendorId: string;
    currency: string;
    billId?: string;
    lines: Array<{ purchaseOrderLineId?: string | null; amount: string }>;
  }
): Promise<PurchaseOrder | null> {
  const linked = opts.lines.map((l, i) => ({ ...l, n: i + 1 })).filter((l) => l.purchaseOrderLineId);
  if (!opts.purchaseOrderId) {
    if (linked.length > 0) {
      throw new AppError("invalid_input", "Lines can point at a purchase order only on a bill made from it. Use create_bill_from_purchase_order.");
    }
    return null;
  }
  const po = await loadPurchaseOrder(ctx, opts.purchaseOrderId, true);
  if (po.vendorId !== opts.vendorId) {
    throw new AppError("invalid_input", `This bill bills ${po.poNumber}; its vendor can't change.`);
  }
  if (po.currency !== opts.currency) {
    throw new AppError("invalid_input", `${po.poNumber} is in ${po.currency}; a bill from it must be too.`);
  }
  // A new bill needs an open PO. Editing a draft bill already on the PO is
  // fine even after the PO closed, as long as it doesn't bill more.
  if (!opts.billId || po.status !== "closed") requireBillablePo(po);
  const poLines = new Map((await linesOfPurchaseOrder(ctx, po.id)).map((l) => [l.id, l]));
  const billed = await billedByPoLine(ctx, po.id, opts.billId);
  const adding = new Map<string, Decimal>();
  for (const l of linked) {
    const pl = poLines.get(l.purchaseOrderLineId!);
    if (!pl) throw new AppError("invalid_input", `Line ${l.n}: that line isn't on ${po.poNumber}.`);
    adding.set(pl.id, (adding.get(pl.id) ?? money(0)).plus(money(l.amount)));
  }
  for (const [lineId, amt] of adding) {
    const pl = poLines.get(lineId)!;
    const left = poRemainingOf(pl, billed.get(lineId));
    if (amt.gt(left)) {
      throw new AppError(
        "invalid_input",
        `${po.poNumber} line ${pl.lineNumber} (${pl.description ?? "no description"}): this bill bills ${amt.toFixed(2)} but only ${left.toFixed(2)} is left.`
      );
    }
  }
  return po;
}

/**
 * Close a PO once every line is fully billed. With `reopen` (after a bill
 * from it is voided, deleted, or lowered), a PO that closed by being fully
 * billed opens again. One closed by hand stays closed.
 */
export async function syncPurchaseOrderStatus(ctx: Ctx, poId: string, opts: { reopen?: boolean } = {}) {
  const po = await loadPurchaseOrder(ctx, poId, true);
  const lines = await linesOfPurchaseOrder(ctx, po.id);
  const billed = await billedByPoLine(ctx, po.id);
  const fullyBilled = lines.length > 0 && lines.every((l) => poRemainingOf(l, billed.get(l.id)).lte(0));
  let next: PurchaseOrder["status"] | null = null;
  if (fullyBilled && po.status === "open") next = "closed";
  if (!fullyBilled && opts.reopen && po.status === "closed" && !po.closeReason) next = "open";
  if (!next) return;
  await ctx.tx
    .update(purchaseOrders)
    .set(
      next === "closed"
        ? { status: next, closedAt: sql`now()`, closedBy: ctx.actor.userId, closeReason: null, updatedAt: sql`now()` }
        : { status: next, closedAt: null, closedBy: null, updatedAt: sql`now()` }
    )
    .where(eq(purchaseOrders.id, po.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: next === "closed" ? "ap.purchase_order.closed" : "ap.purchase_order.reopened",
      entityType: "purchase_order",
      entityId: po.id,
      metadata: { poNumber: po.poNumber, automatic: true },
    },
    ctx.tx
  );
}

/** Purchase orders are billed only while open. */
export function requireBillablePo(po: PurchaseOrder) {
  if (po.status !== "open") {
    throw invalidState(
      po.status === "closed"
        ? `${po.poNumber} is closed. Reopen it to bill more.`
        : `${po.poNumber} is ${po.status.replace("_", " ")}; only approved (open) purchase orders can be billed.`
    );
  }
}
