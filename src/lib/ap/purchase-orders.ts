import Decimal from "decimal.js";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  apBills,
  items,
  purchaseOrderLines,
  purchaseOrders,
  vendors,
  type PurchaseOrder,
  type PurchaseOrderLine,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AddressSchema, compactAddress, loadCompanyProfile } from "@/lib/company/profile";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { lineAmount } from "@/lib/ar/documents";
import { nextNumber } from "@/lib/gl/number-series";
import { requireLineAccounts } from "@/lib/gl/lookups";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { amount, currency, flag, id, isoDate, likePattern, optionalText, pagination, toPage, type Page } from "@/lib/schemas";
import { canApproveAtRole, resolveApprovalRouting } from "./approval";
import { createBill, type BillDetail } from "./bills";
import {
  billedByPoLine,
  linesOfPurchaseOrder,
  loadPurchaseOrder,
  poRemainingOf,
  requireBillablePo,
} from "./po-billing";

/**
 * PURCHASE ORDERS: what we've ordered from a vendor. No ledger impact.
 *
 *   draft → pending_approval → open | rejected → closed
 *
 * Submitting routes the PO through the bill approval thresholds. A person
 * whose role meets the threshold approves it in the same step; anything
 * else (and anything an agent submits) waits for an approver. Open POs are
 * sent and billed, in parts if need be (create_bill_from_purchase_order).
 * A PO closes when fully billed, or by hand.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const LineSchema = z
  .object({
    itemId: id.optional().describe("Product or service ordered. Fills the account and cost from the item when left out."),
    accountId: id.optional().describe("Account the bills will debit (expense, asset, or COGS). Required without an item that has one."),
    description: optionalText(500),
    quantity: amount.optional().describe("Default 1."),
    unitCost: amount.optional().describe("Cost per unit. Defaults to the item's purchase cost."),
  })
  .describe("One thing ordered.");

const PoFields = {
  vendorId: id,
  poDate: isoDate.describe("Order date."),
  expectedDate: isoDate.optional().nullable().describe("When the order should arrive."),
  shipTo: AddressSchema.optional().describe("Delivery address. Defaults to the company address."),
  currency: currency.optional().describe("Defaults to the vendor's currency."),
  exchangeRate: amount.optional(),
  vendorMessage: optionalText(2000).describe("Printed on the PO for the vendor."),
  memo: optionalText(2000).describe("Internal note; not printed."),
  lines: z.array(LineSchema).min(1, "A purchase order needs at least 1 line."),
};

export const CreatePurchaseOrderSchema = z.object({
  ...PoFields,
  submit: z.boolean().optional().describe("Also submit it for approval. Approved at once when your role meets the bill approval threshold."),
});
export type CreatePurchaseOrderInput = z.input<typeof CreatePurchaseOrderSchema>;

export const UpdatePurchaseOrderSchema = z.object({ id, ...PoFields });
export type UpdatePurchaseOrderInput = z.input<typeof UpdatePurchaseOrderSchema>;

export const ListPurchaseOrdersSchema = z.object({
  status: z.enum(["draft", "pending_approval", "rejected", "open", "closed"]).optional(),
  vendorId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional().describe("Search PO number, vendor, or memo."),
  openOnly: flag.optional().describe("Only open purchase orders (approved, not fully billed)."),
  ...pagination,
});

export const CreateBillFromPurchaseOrderSchema = z
  .object({
    id: id.describe("The purchase order to bill."),
    billDate: isoDate,
    dueDate: isoDate.optional().describe("Defaults to bill date + the vendor's terms."),
    vendorInvoiceNumber: optionalText(100),
    mode: z
      .enum(["remaining", "percent", "custom"])
      .default("remaining")
      .describe("remaining: bill everything not billed yet. percent: bill `percent` of each line. custom: bill the `lines` amounts."),
    percent: amount.optional().describe("With mode percent: 0 < percent ≤ 100."),
    lines: z
      .array(z.object({ purchaseOrderLineId: id, amount }))
      .optional()
      .describe("With mode custom: amount to bill per PO line. Lines left out bill nothing."),
    description: optionalText(500),
    submit: z.boolean().optional().describe("Also submit the bill for approval."),
  })
  .refine((d) => d.mode !== "percent" || (d.percent && money(d.percent).gt(0) && money(d.percent).lte(100)), {
    message: "percent must be more than 0 and at most 100.",
  })
  .refine((d) => d.mode !== "custom" || (d.lines && d.lines.length > 0), { message: "mode custom needs lines." });
export type CreateBillFromPurchaseOrderInput = z.input<typeof CreateBillFromPurchaseOrderSchema>;

const IdSchema = z.object({ id });
const ReasonSchema = z.object({ id, reason: z.string().trim().min(1, "A reason is required.").max(500) });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type PurchaseOrderRow = PurchaseOrder & { vendorName: string; billedAmount: string };
export type PurchaseOrderLineRow = PurchaseOrderLine & {
  itemName: string | null;
  accountCode: string;
  accountName: string;
  billed: string;
  remaining: string;
};
export type PurchaseOrderDetail = PurchaseOrderRow & {
  lines: PurchaseOrderLineRow[];
  remainingAmount: string;
  bills: Array<{ id: string; billNumber: string; billDate: string; status: string; totalAmount: string }>;
};

/** Σ of bill lines on live bills that bill this PO. */
const billedSql = sql<string>`(SELECT COALESCE(SUM(bl.amount), 0) FROM ap_bill_lines bl
  JOIN ap_bills b ON b.id = bl.bill_id
  WHERE b.purchase_order_id = "purchase_orders"."id" AND b.status <> 'voided' AND b.deleted_at IS NULL
    AND bl.purchase_order_line_id IS NOT NULL)::text`;

export async function listPurchaseOrders(ctx: Ctx, input: z.input<typeof ListPurchaseOrdersSchema>): Promise<Page<PurchaseOrderRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list purchase orders");
  const f = ListPurchaseOrdersSchema.parse(input);
  const rows = await ctx.tx
    .select({ po: purchaseOrders, vendorName: vendors.name, billedAmount: billedSql })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(
      and(
        eq(purchaseOrders.organizationId, ctx.actor.organizationId),
        isNull(purchaseOrders.deletedAt),
        f.status ? eq(purchaseOrders.status, f.status) : undefined,
        f.openOnly ? eq(purchaseOrders.status, "open") : undefined,
        f.vendorId ? eq(purchaseOrders.vendorId, f.vendorId) : undefined,
        f.from ? gte(purchaseOrders.poDate, f.from) : undefined,
        f.to ? lte(purchaseOrders.poDate, f.to) : undefined,
        f.q
          ? or(ilike(purchaseOrders.poNumber, likePattern(f.q)), ilike(purchaseOrders.memo, likePattern(f.q)), ilike(vendors.name, likePattern(f.q)))
          : undefined
      )
    )
    .orderBy(desc(purchaseOrders.poDate), desc(purchaseOrders.poNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.po, vendorName: r.vendorName, billedAmount: r.billedAmount })),
    f.limit,
    f.offset
  );
}

export async function getPurchaseOrder(ctx: Ctx, input: { id: string }): Promise<PurchaseOrderDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view purchase orders");
  const { id: poId } = IdSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId);
  const [v] = await ctx.tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, po.vendorId));
  const lines = await ctx.tx
    .select({ line: purchaseOrderLines, itemName: items.name, accountCode: accounts.code, accountName: accounts.name })
    .from(purchaseOrderLines)
    .innerJoin(accounts, eq(accounts.id, purchaseOrderLines.accountId))
    .leftJoin(items, eq(items.id, purchaseOrderLines.itemId))
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(purchaseOrderLines.lineNumber));
  const billed = await billedByPoLine(ctx, po.id);
  const rows = lines.map((l) => {
    const b = billed.get(l.line.id) ?? money(0);
    return {
      ...l.line,
      itemName: l.itemName,
      accountCode: l.accountCode,
      accountName: l.accountName,
      billed: toDbMoney(b),
      remaining: toDbMoney(poRemainingOf(l.line, b)),
    };
  });
  const bills = await ctx.tx
    .select({ id: apBills.id, billNumber: apBills.billNumber, billDate: apBills.billDate, status: apBills.status, totalAmount: apBills.totalAmount })
    .from(apBills)
    .where(and(eq(apBills.purchaseOrderId, po.id), isNull(apBills.deletedAt)))
    .orderBy(asc(apBills.billDate), asc(apBills.billNumber));
  const billedAmount = sumMoney(rows.map((r) => r.billed));
  return {
    ...po,
    vendorName: v?.name ?? "",
    billedAmount: toDbMoney(billedAmount),
    remainingAmount: toDbMoney(sumMoney(rows.map((r) => r.remaining))),
    lines: rows,
    bills,
  };
}

// ---------------------------------------------------------------------------
// Create / update (draft or rejected only)
// ---------------------------------------------------------------------------

async function resolvePo(ctx: Ctx, data: z.output<typeof CreatePurchaseOrderSchema> | z.output<typeof UpdatePurchaseOrderSchema>) {
  const org = ctx.actor.organizationId;
  const [vendor] = await ctx.tx.select().from(vendors).where(and(eq(vendors.id, data.vendorId), eq(vendors.organizationId, org)));
  if (!vendor) throw notFound("Vendor");
  if (!vendor.isActive) throw new AppError("invalid_input", `Vendor ${vendor.name} is inactive.`);
  if (data.expectedDate && data.expectedDate < data.poDate) {
    throw new AppError("invalid_input", "The expected date can't be before the order date.");
  }

  const itemIds = data.lines.map((l) => l.itemId).filter((x): x is string => !!x);
  const itemRows = itemIds.length
    ? await ctx.tx.select().from(items).where(and(eq(items.organizationId, org), inArray(items.id, itemIds)))
    : [];
  const byId = new Map(itemRows.map((i) => [i.id, i]));
  const lines = data.lines.map((l, i) => {
    const item = l.itemId ? byId.get(l.itemId) : undefined;
    if (l.itemId && !item) throw new AppError("invalid_input", `Line ${i + 1}: item not found.`);
    if (item && !item.isActive) throw new AppError("invalid_input", `Line ${i + 1}: ${item.name} is inactive.`);
    // Inventory items are bought into stock: their bills debit the asset account.
    if (item?.type === "inventory" && !item.assetAccountId) {
      throw new AppError("invalid_state", `${item.name} has no inventory asset account. Edit the item first.`);
    }
    const accountId = item?.type === "inventory" ? item.assetAccountId : (l.accountId ?? item?.expenseAccountId);
    if (!accountId) {
      throw new AppError("invalid_input", `Line ${i + 1}: choose an account${item ? ` (${item.name} has no expense account)` : ""}.`);
    }
    const unitCost = l.unitCost ?? item?.purchaseCost;
    if (unitCost === undefined || unitCost === null) throw new AppError("invalid_input", `Line ${i + 1}: enter a unit cost.`);
    const quantity = l.quantity ?? "1";
    const amt = lineAmount(quantity, unitCost);
    if (!money(amt).gt(0)) throw new AppError("invalid_input", `Line ${i + 1}: the amount must be more than zero.`);
    return {
      itemId: item?.id ?? null,
      accountId,
      description: l.description ?? item?.description ?? item?.name ?? null,
      quantity: toDbMoney(quantity),
      unitCost: toDbMoney(unitCost),
      amount: amt,
    };
  });
  await requireLineAccounts(ctx.tx, org, lines.map((l) => l.accountId));

  let shipTo = data.shipTo ? compactAddress(data.shipTo) : null;
  if (!shipTo || Object.keys(shipTo).length === 0) {
    const { profile } = await loadCompanyProfile(ctx);
    shipTo = profile?.address ?? {};
  }
  return {
    header: {
      vendorId: vendor.id,
      poDate: data.poDate,
      expectedDate: data.expectedDate ?? null,
      shipTo,
      currency: data.currency ?? vendor.currency,
      exchangeRate: data.exchangeRate ?? "1",
      totalAmount: toDbMoney(sumMoney(lines.map((l) => l.amount))),
      vendorMessage: data.vendorMessage,
      memo: data.memo,
    },
    lines,
  };
}

async function insertLines(ctx: Ctx, poId: string, lines: Awaited<ReturnType<typeof resolvePo>>["lines"]) {
  await ctx.tx.insert(purchaseOrderLines).values(
    lines.map((l, i) => ({ organizationId: ctx.actor.organizationId, purchaseOrderId: poId, lineNumber: i + 1, ...l }))
  );
}

async function audit(ctx: Ctx, event: string, po: Pick<PurchaseOrder, "id" | "poNumber">, metadata: Record<string, unknown> = {}) {
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: `ap.purchase_order.${event}`,
      entityType: "purchase_order",
      entityId: po.id,
      metadata: { poNumber: po.poNumber, ...metadata },
    },
    ctx.tx
  );
}

export async function createPurchaseOrder(ctx: Ctx, input: CreatePurchaseOrderInput): Promise<PurchaseOrderDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create purchase orders");
  const data = CreatePurchaseOrderSchema.parse(input);
  const { header, lines } = await resolvePo(ctx, data);
  const poNumber = await nextNumber(ctx.tx, ctx.actor.organizationId, "PO");
  const [po] = await ctx.tx
    .insert(purchaseOrders)
    .values({ organizationId: ctx.actor.organizationId, poNumber, ...header, status: "draft", ...creatorFields(ctx.actor) })
    .returning();
  await insertLines(ctx, po.id, lines);
  await audit(ctx, "created", po, { vendorId: header.vendorId, total: header.totalAmount, lineCount: lines.length });
  if (data.submit) await submitPurchaseOrder(ctx, { id: po.id });
  return getPurchaseOrder(ctx, { id: po.id });
}

export async function updatePurchaseOrder(ctx: Ctx, input: UpdatePurchaseOrderInput): Promise<PurchaseOrderDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit purchase orders");
  const data = UpdatePurchaseOrderSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, data.id, true);
  if (po.status !== "draft" && po.status !== "rejected") {
    throw invalidState(`${po.poNumber} is ${po.status.replace("_", " ")}. Only draft or rejected purchase orders can be edited.`);
  }
  const { header, lines } = await resolvePo(ctx, data);
  await ctx.tx
    .update(purchaseOrders)
    .set({
      ...header,
      // Saving a rejected PO puts it back in draft.
      status: "draft",
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      updatedAt: sql`now()`,
    })
    .where(eq(purchaseOrders.id, po.id));
  await ctx.tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
  await insertLines(ctx, po.id, lines);
  await audit(ctx, "updated", po, { total: header.totalAmount });
  return getPurchaseOrder(ctx, { id: po.id });
}

export async function deleteDraftPurchaseOrder(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft purchase orders");
  const { id: poId } = IdSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId, true);
  if (po.status !== "draft" && po.status !== "rejected") {
    throw invalidState(`${po.poNumber} is ${po.status.replace("_", " ")}. Only draft or rejected purchase orders can be deleted; close it instead.`);
  }
  await ctx.tx.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
  await audit(ctx, "deleted", po);
  return { id: po.id };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export async function submitPurchaseOrder(ctx: Ctx, input: { id: string }): Promise<PurchaseOrderDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "submit purchase orders for approval");
  const { id: poId } = IdSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId, true);
  if (po.status !== "draft") throw invalidState(`Only draft purchase orders can be submitted (${po.poNumber} is ${po.status.replace("_", " ")}).`);
  const routing = await resolveApprovalRouting(ctx.tx, ctx.actor.organizationId, "ap_bill", po.totalAmount);
  // A person who could approve it approves it by submitting. Agents never do.
  const approveNow = !ctx.actor.agentId && ctx.actor.scopes.includes("post") && canApproveAtRole(ctx.actor.role, routing.requiredRole);
  await ctx.tx
    .update(purchaseOrders)
    .set({
      status: approveNow ? "open" : "pending_approval",
      submittedAt: sql`now()`,
      submittedBy: ctx.actor.userId,
      approvalThresholdId: routing.threshold?.id ?? null,
      ...(approveNow ? { approvedAt: sql`now()`, approvedBy: ctx.actor.userId } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(purchaseOrders.id, po.id));
  await audit(ctx, "submitted", po, { total: po.totalAmount, requiredRole: routing.requiredRole, fallback: routing.fallback });
  if (approveNow) await audit(ctx, "approved", po, { total: po.totalAmount, approverRole: ctx.actor.role, requiredRole: routing.requiredRole, onSubmit: true });
  return getPurchaseOrder(ctx, { id: po.id });
}

async function requireApprover(ctx: Ctx, po: PurchaseOrder, verb: "approve" | "reject") {
  requirePermission(ctx.actor, "post", "accountant", `${verb} purchase orders`);
  if (po.status !== "pending_approval") {
    throw invalidState(`Only purchase orders waiting for approval can be ${verb}d (${po.poNumber} is ${po.status.replace("_", " ")}).`);
  }
  // Re-resolve against the current thresholds: they may have changed.
  const routing = await resolveApprovalRouting(ctx.tx, ctx.actor.organizationId, "ap_bill", po.totalAmount);
  if (!canApproveAtRole(ctx.actor.role, routing.requiredRole)) {
    throw new AppError(
      "forbidden",
      `Role "${ctx.actor.role}" can't ${verb} this purchase order: "${routing.requiredRole}" or higher is required for ${money(po.totalAmount).toFixed(2)}.`,
      { requiredRole: routing.requiredRole }
    );
  }
  if (ctx.actor.agentId && po.createdByAgentId === ctx.actor.agentId) {
    throw new AppError("forbidden", `An agent can't ${verb} a purchase order it created. A person or another approver must review it.`);
  }
  return routing;
}

export async function approvePurchaseOrder(ctx: Ctx, input: { id: string }): Promise<PurchaseOrderDetail> {
  const { id: poId } = IdSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId, true);
  const routing = await requireApprover(ctx, po, "approve");
  await ctx.tx
    .update(purchaseOrders)
    .set({
      status: "open",
      approvedAt: sql`now()`,
      approvedBy: ctx.actor.userId,
      approvalThresholdId: routing.threshold?.id ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(purchaseOrders.id, po.id));
  await audit(ctx, "approved", po, { total: po.totalAmount, approverRole: ctx.actor.role, requiredRole: routing.requiredRole });
  return getPurchaseOrder(ctx, { id: po.id });
}

export async function rejectPurchaseOrder(ctx: Ctx, input: z.input<typeof ReasonSchema>): Promise<PurchaseOrderDetail> {
  const { id: poId, reason } = ReasonSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId, true);
  await requireApprover(ctx, po, "reject");
  await ctx.tx
    .update(purchaseOrders)
    .set({ status: "rejected", rejectedAt: sql`now()`, rejectedBy: ctx.actor.userId, rejectionReason: reason, updatedAt: sql`now()` })
    .where(eq(purchaseOrders.id, po.id));
  await audit(ctx, "rejected", po, { reason, rejectorRole: ctx.actor.role });
  return getPurchaseOrder(ctx, { id: po.id });
}

// ---------------------------------------------------------------------------
// Sent, closed, reopened
// ---------------------------------------------------------------------------

export async function markPurchaseOrderSent(ctx: Ctx, input: { id: string }): Promise<PurchaseOrderDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "mark purchase orders sent");
  const { id: poId } = IdSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId, true);
  if (po.status !== "open" && po.status !== "closed") {
    throw invalidState(`${po.poNumber} isn't approved yet; send it once it's open.`);
  }
  await ctx.tx.update(purchaseOrders).set({ sentAt: sql`now()`, updatedAt: sql`now()` }).where(eq(purchaseOrders.id, po.id));
  await audit(ctx, "sent", po);
  return getPurchaseOrder(ctx, { id: po.id });
}

export async function closePurchaseOrder(ctx: Ctx, input: z.input<typeof ReasonSchema>): Promise<PurchaseOrderDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "close purchase orders");
  const { id: poId, reason } = ReasonSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId, true);
  if (po.status !== "open") throw invalidState(`Only open purchase orders can be closed (${po.poNumber} is ${po.status.replace("_", " ")}).`);
  await ctx.tx
    .update(purchaseOrders)
    .set({ status: "closed", closedAt: sql`now()`, closedBy: ctx.actor.userId, closeReason: reason, updatedAt: sql`now()` })
    .where(eq(purchaseOrders.id, po.id));
  await audit(ctx, "closed", po, { reason });
  return getPurchaseOrder(ctx, { id: po.id });
}

export async function reopenPurchaseOrder(ctx: Ctx, input: { id: string }): Promise<PurchaseOrderDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "reopen purchase orders");
  const { id: poId } = IdSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, poId, true);
  if (po.status !== "closed") throw invalidState(`${po.poNumber} isn't closed.`);
  const lines = await linesOfPurchaseOrder(ctx, po.id);
  const billed = await billedByPoLine(ctx, po.id);
  if (lines.every((l) => poRemainingOf(l, billed.get(l.id)).lte(0))) {
    throw invalidState(`${po.poNumber} is fully billed; there's nothing left to reopen it for.`);
  }
  await ctx.tx
    .update(purchaseOrders)
    .set({ status: "open", closedAt: null, closedBy: null, closeReason: null, updatedAt: sql`now()` })
    .where(eq(purchaseOrders.id, po.id));
  await audit(ctx, "reopened", po);
  return getPurchaseOrder(ctx, { id: po.id });
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export async function createBillFromPurchaseOrder(ctx: Ctx, input: CreateBillFromPurchaseOrderInput): Promise<BillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create bills");
  const d = CreateBillFromPurchaseOrderSchema.parse(input);
  const po = await loadPurchaseOrder(ctx, d.id, true);
  requireBillablePo(po);
  const lines = await linesOfPurchaseOrder(ctx, po.id);
  const billed = await billedByPoLine(ctx, po.id);
  const custom = new Map((d.lines ?? []).map((l) => [l.purchaseOrderLineId, money(l.amount)]));
  for (const lineId of custom.keys()) {
    if (!lines.some((l) => l.id === lineId)) throw new AppError("invalid_input", `That line isn't on ${po.poNumber}.`);
  }

  const billLines = lines
    .map((pl) => {
      const left = poRemainingOf(pl, billed.get(pl.id));
      let amt: Decimal;
      if (d.mode === "remaining") amt = left;
      else if (d.mode === "custom") amt = custom.get(pl.id) ?? money(0);
      else {
        amt = money(pl.amount).times(money(d.percent!)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        // Never past what's left: the last percent bills the rounding remainder.
        if (amt.gt(left)) amt = left;
      }
      return { pl, amt };
    })
    .filter((x) => x.amt.gt(0));
  if (billLines.length === 0) throw invalidState(`Nothing left to bill on ${po.poNumber}.`);

  const bill = await createBill(
    ctx,
    {
      vendorId: po.vendorId,
      billDate: d.billDate,
      dueDate: d.dueDate,
      vendorInvoiceNumber: d.vendorInvoiceNumber,
      currency: po.currency,
      // Stored with 10 places; the rate itself came in with at most 4.
      exchangeRate: money(po.exchangeRate).toString(),
      description: d.description ?? `Bills ${po.poNumber}`,
      lines: billLines.map(({ pl, amt }) => ({
        accountId: pl.accountId,
        amount: toDbMoney(amt),
        description: pl.description,
        // Billing part of a line bills that share of its quantity.
        itemId: pl.itemId,
        quantity: pl.itemId ? toDbMoney(money(pl.quantity).times(amt).div(money(pl.amount))) : null,
        purchaseOrderLineId: pl.id,
      })),
      submit: d.submit,
    },
    { purchaseOrderId: po.id }
  );
  await audit(ctx, "billed", po, { billId: bill.id, billNumber: bill.billNumber, amount: bill.totalAmount, mode: d.mode });
  return bill;
}
