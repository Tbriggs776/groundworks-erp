import { addDays, format, parseISO } from "date-fns";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  apBillLines,
  apBills,
  purchaseOrders,
  vendors,
  type ApBill,
  type ApBillLine,
} from "@/lib/db/schema";
import {
  auditFields,
  creatorFields,
  requirePermission,
  requirePostingWithinLimit,
  type Ctx,
} from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { requireLineAccounts } from "@/lib/gl/lookups";
import { PurchaseLineItemFields, resolvePurchaseLines, type ResolvedPurchaseLine } from "@/lib/inventory/documents";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import {
  amount,
  currency,
  flag,
  id,
  isoDate,
  likePattern,
  optionalText,
  type Page,
  pagination,
  positiveAmount,
  toPage,
} from "@/lib/schemas";
import { canApproveAtRole, resolveApprovalRouting } from "./approval";
import { billSettledSql } from "./balances";
import { billAppliedTotal } from "./payments";
import { checkPurchaseOrderBilling, syncPurchaseOrderStatus } from "./po-billing";
import { postBillToGl, voidBillFromGl } from "./posting";

/**
 * BILLS (AP) — vendor invoices. Lifecycle, enforced here for every caller
 * (web UI, REST, MCP):
 *
 *   draft → pending_approval → approved | rejected → posted → paid | voided
 *
 * Rejected bills are editable and drop back to draft when saved. Approval
 * routing comes from approval_thresholds; an agent never approves a bill
 * it created itself. A bill made from a purchase order bills its lines
 * (see ./po-billing.ts); voiding or deleting it gives them back.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BillLineSchema = z.object({
  accountId: id
    .optional()
    .nullable()
    .describe("Expense, asset, or COGS account to debit. Optional with an item: inventory items always debit their asset account; others default to their expense account."),
  amount: positiveAmount.optional().nullable().describe("Line amount in the bill's currency. Optional when quantity and unit cost are given."),
  ...PurchaseLineItemFields,
  description: optionalText(500),
  purchaseOrderLineId: id
    .optional()
    .nullable()
    .describe("The purchase order line this line bills. Only on bills made from a purchase order; keep it when editing one."),
});

const BillFields = {
  vendorId: id.describe("Vendor the bill is from."),
  vendorInvoiceNumber: optionalText(100).describe(
    "The vendor's own invoice number. Used for duplicate detection."
  ),
  billDate: isoDate.describe("Date on the vendor's invoice."),
  dueDate: isoDate
    .optional()
    .describe("Defaults to bill date + the vendor's payment terms."),
  discountDate: isoDate.optional().nullable().describe("Last day for an early-pay discount."),
  discountPercent: amount.optional().describe("Early-pay discount percent, e.g. \"2\" for 2/10 net 30."),
  currency: currency.optional().describe("Defaults to the vendor's currency."),
  exchangeRate: amount.optional().describe("Rate to base currency. Defaults to 1."),
  description: optionalText(500),
  notes: optionalText(),
  lines: z.array(BillLineSchema).min(1, "A bill needs at least 1 line."),
};

export const CreateBillSchema = z.object({
  ...BillFields,
  submit: z
    .boolean()
    .optional()
    .describe("Also submit the bill for approval in the same call."),
});
export type CreateBillInput = z.input<typeof CreateBillSchema>;

export const UpdateBillSchema = z.object({ id, ...BillFields });
export type UpdateBillInput = z.input<typeof UpdateBillSchema>;

export const ListBillsSchema = z.object({
  status: z
    .enum(["draft", "pending_approval", "rejected", "approved", "posted", "paid", "voided"])
    .optional(),
  vendorId: id.optional(),
  q: z.string().trim().optional().describe("Search bill #, vendor invoice #, or description."),
  unpaidOnly: flag.optional().describe("Only posted bills with an open balance."),
  ...pagination,
});

export const BillIdSchema = z.object({ id });
export const ReasonSchema = z.object({
  id,
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type BillListRow = ApBill & { vendorName: string; openBalance: string };

export async function listBills(
  ctx: Ctx,
  input: z.input<typeof ListBillsSchema>
): Promise<Page<BillListRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list bills");
  const f = ListBillsSchema.parse(input);
  const org = ctx.actor.organizationId;

  const paidSoFar = billSettledSql(sql`"ap_bills"."id"`);

  const rows = await ctx.tx
    .select({
      bill: apBills,
      vendorName: vendors.name,
      openBalance: sql<string>`(${apBills.totalAmount} - ${paidSoFar})::text`,
    })
    .from(apBills)
    .innerJoin(vendors, eq(vendors.id, apBills.vendorId))
    .where(
      and(
        eq(apBills.organizationId, org),
        isNull(apBills.deletedAt),
        f.status ? eq(apBills.status, f.status) : undefined,
        f.vendorId ? eq(apBills.vendorId, f.vendorId) : undefined,
        f.unpaidOnly ? eq(apBills.status, "posted") : undefined,
        f.q
          ? or(
              ilike(apBills.billNumber, likePattern(f.q)),
              ilike(apBills.vendorInvoiceNumber, likePattern(f.q)),
              ilike(apBills.description, likePattern(f.q)),
              ilike(vendors.name, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(desc(apBills.billDate), desc(apBills.billNumber))
    .limit(f.limit + 1)
    .offset(f.offset);

  return toPage(
    rows.map((r) => ({ ...r.bill, vendorName: r.vendorName, openBalance: r.openBalance })),
    f.limit,
    f.offset
  );
}

export type BillDetail = ApBill & {
  vendorName: string;
  openBalance: string;
  lines: ApBillLine[];
  purchaseOrderNumber: string | null;
};

export async function getBill(ctx: Ctx, input: { id: string }): Promise<BillDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view bills");
  const { id: billId } = BillIdSchema.parse(input);
  const bill = await loadBill(ctx, billId);
  const [vendor] = await ctx.tx
    .select({ name: vendors.name })
    .from(vendors)
    .where(eq(vendors.id, bill.vendorId));
  const lines = await ctx.tx
    .select()
    .from(apBillLines)
    .where(eq(apBillLines.billId, billId))
    .orderBy(asc(apBillLines.lineNumber));
  const applied = await billAppliedTotal(ctx.tx, billId);
  const open =
    bill.status === "posted" || bill.status === "paid"
      ? money(bill.totalAmount).minus(applied)
      : money(0);
  const [po] = bill.purchaseOrderId
    ? await ctx.tx.select({ poNumber: purchaseOrders.poNumber }).from(purchaseOrders).where(eq(purchaseOrders.id, bill.purchaseOrderId))
    : [];
  return { ...bill, vendorName: vendor?.name ?? "", openBalance: toDbMoney(open), lines, purchaseOrderNumber: po?.poNumber ?? null };
}

async function loadBill(ctx: Ctx, billId: string, forUpdate = false): Promise<ApBill> {
  const q = ctx.tx
    .select()
    .from(apBills)
    .where(
      and(
        eq(apBills.id, billId),
        eq(apBills.organizationId, ctx.actor.organizationId),
        isNull(apBills.deletedAt)
      )
    );
  const [bill] = forUpdate ? await q.for("update") : await q;
  if (!bill) throw notFound("Bill");
  return bill;
}

// ---------------------------------------------------------------------------
// Create / update (draft only)
// ---------------------------------------------------------------------------

async function resolveBillFields(
  ctx: Ctx,
  data: z.output<typeof CreateBillSchema> | z.output<typeof UpdateBillSchema>,
  link: { purchaseOrderId: string | null; billId?: string } = { purchaseOrderId: null }
) {
  const org = ctx.actor.organizationId;
  const [vendor] = await ctx.tx
    .select()
    .from(vendors)
    .where(and(eq(vendors.id, data.vendorId), eq(vendors.organizationId, org)));
  if (!vendor) throw notFound("Vendor");
  if (!vendor.isActive) {
    throw new AppError("invalid_input", `Vendor ${vendor.name} is inactive.`);
  }

  const lines = await resolvePurchaseLines(ctx, data.lines, { allowInventory: true });
  await requireLineAccounts(ctx.tx, org, lines.map((l) => l.accountId));
  const currency = data.currency ?? vendor.currency;
  await checkPurchaseOrderBilling(ctx, {
    purchaseOrderId: link.purchaseOrderId,
    vendorId: vendor.id,
    currency,
    billId: link.billId,
    lines,
  });

  const subtotal = sumMoney(lines.map((l) => l.amount));
  const dueDate =
    data.dueDate ??
    format(addDays(parseISO(data.billDate), vendor.defaultPaymentTermsDays), "yyyy-MM-dd");
  if (dueDate < data.billDate) {
    throw new AppError("invalid_input", "Due date can't be before the bill date.");
  }

  return {
    header: {
      vendorId: vendor.id,
      vendorInvoiceNumber: data.vendorInvoiceNumber,
      billDate: data.billDate,
      dueDate,
      discountDate: data.discountDate ?? null,
      discountPercent: money(data.discountPercent ?? "0").toFixed(6),
      currency,
      exchangeRate: data.exchangeRate ?? "1",
      subtotalAmount: toDbMoney(subtotal),
      // Discount terms affect payment-time math only; the bill is owed in full.
      totalAmount: toDbMoney(subtotal),
      description: data.description,
      notes: data.notes,
    },
    lines,
    vendor,
  };
}

/** Warn-level duplicate check: same vendor + vendor invoice # already live. */
async function assertNotDuplicate(
  ctx: Ctx,
  vendorId: string,
  invoiceNo: string | null | undefined,
  exceptId?: string
) {
  if (!invoiceNo) return;
  const [dup] = await ctx.tx
    .select({ id: apBills.id, billNumber: apBills.billNumber })
    .from(apBills)
    .where(
      and(
        eq(apBills.organizationId, ctx.actor.organizationId),
        eq(apBills.vendorId, vendorId),
        eq(apBills.vendorInvoiceNumber, invoiceNo),
        sql`${apBills.status} <> 'voided'`,
        exceptId ? sql`${apBills.id} <> ${exceptId}` : undefined
      )
    )
    .limit(1);
  if (dup) {
    throw new AppError(
      "conflict",
      `This vendor's invoice ${invoiceNo} is already entered as ${dup.billNumber}.`,
      { existingBillId: dup.id }
    );
  }
}

/** Bill lines as stored, with their PO line links. */
function billLineRows(org: string, billId: string, lines: Array<z.output<typeof BillLineSchema> & ResolvedPurchaseLine>) {
  return lines.map((l, i) => ({
    organizationId: org,
    billId,
    lineNumber: i + 1,
    accountId: l.accountId,
    amount: l.amount,
    description: l.description,
    itemId: l.itemId,
    quantity: l.quantity,
    unitCost: l.unitCost,
    lotNumber: l.lotNumber,
    lotExpiresOn: l.lotExpiresOn,
    purchaseOrderLineId: l.purchaseOrderLineId ?? null,
  }));
}

/**
 * `links` is for callers inside the app (a purchase order being billed, a
 * recurring template running); API callers use the operations made for
 * those.
 */
export async function createBill(
  ctx: Ctx,
  input: CreateBillInput,
  links: { purchaseOrderId?: string; recurringBillId?: string } = {}
): Promise<BillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create bills");
  const data = CreateBillSchema.parse(input);
  const org = ctx.actor.organizationId;
  const purchaseOrderId = links.purchaseOrderId ?? null;
  const { header, lines } = await resolveBillFields(ctx, data, { purchaseOrderId });
  await assertNotDuplicate(ctx, header.vendorId, header.vendorInvoiceNumber);

  const billNumber = await nextNumber(ctx.tx, org, "AP");
  const [bill] = await ctx.tx
    .insert(apBills)
    .values({
      organizationId: org,
      billNumber,
      ...header,
      purchaseOrderId,
      recurringBillId: links.recurringBillId ?? null,
      status: "draft",
      ...creatorFields(ctx.actor),
    })
    .returning();

  await ctx.tx.insert(apBillLines).values(billLineRows(org, bill.id, lines));
  if (purchaseOrderId) await syncPurchaseOrderStatus(ctx, purchaseOrderId);

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.bill.created",
      entityType: "ap_bill",
      entityId: bill.id,
      metadata: {
        billNumber,
        vendorId: header.vendorId,
        total: header.totalAmount,
        lineCount: lines.length,
        ...(purchaseOrderId ? { purchaseOrderId } : {}),
      },
    },
    ctx.tx
  );

  if (data.submit) await submitBill(ctx, { id: bill.id });
  return getBill(ctx, { id: bill.id });
}

export async function updateBill(ctx: Ctx, input: UpdateBillInput): Promise<BillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit bills");
  const data = UpdateBillSchema.parse(input);
  const org = ctx.actor.organizationId;
  const bill = await loadBill(ctx, data.id, true);
  if (bill.status !== "draft" && bill.status !== "rejected") {
    throw invalidState(
      `Cannot edit a ${bill.status} bill. Only draft or rejected bills are editable.`
    );
  }
  const { header, lines } = await resolveBillFields(ctx, data, { purchaseOrderId: bill.purchaseOrderId, billId: bill.id });
  await assertNotDuplicate(ctx, header.vendorId, header.vendorInvoiceNumber, bill.id);

  await ctx.tx
    .update(apBills)
    .set({
      ...header,
      // Saving a rejected bill puts it back in draft.
      status: "draft",
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      updatedAt: sql`now()`,
    })
    .where(eq(apBills.id, bill.id));

  await ctx.tx.delete(apBillLines).where(eq(apBillLines.billId, bill.id));
  await ctx.tx.insert(apBillLines).values(billLineRows(org, bill.id, lines));
  if (bill.purchaseOrderId) await syncPurchaseOrderStatus(ctx, bill.purchaseOrderId, { reopen: true });

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.bill.updated",
      entityType: "ap_bill",
      entityId: bill.id,
      metadata: { billNumber: bill.billNumber, total: header.totalAmount },
    },
    ctx.tx
  );

  return getBill(ctx, { id: bill.id });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export async function submitBill(ctx: Ctx, input: { id: string }): Promise<BillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "submit bills for approval");
  const { id: billId } = BillIdSchema.parse(input);
  const bill = await loadBill(ctx, billId, true);
  if (bill.status !== "draft") {
    throw invalidState(`Can only submit draft bills (this one is ${bill.status}).`);
  }
  const routing = await resolveApprovalRouting(
    ctx.tx,
    ctx.actor.organizationId,
    "ap_bill",
    bill.totalAmount
  );

  await ctx.tx
    .update(apBills)
    .set({
      status: "pending_approval",
      submittedAt: sql`now()`,
      submittedBy: ctx.actor.userId,
      approvalThresholdId: routing.threshold?.id ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(apBills.id, billId));

  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.bill.submitted",
      entityType: "ap_bill",
      entityId: billId,
      metadata: {
        billNumber: bill.billNumber,
        total: bill.totalAmount,
        requiredRole: routing.requiredRole,
        fallback: routing.fallback,
      },
    },
    ctx.tx
  );
  return getBill(ctx, { id: billId });
}

/** Shared gate for approve / reject: threshold role + no self-approval by agents. */
async function requireApprover(ctx: Ctx, bill: ApBill, verb: "approve" | "reject") {
  requirePermission(ctx.actor, "post", "accountant", `${verb} bills`);
  if (bill.status !== "pending_approval") {
    throw invalidState(
      `Only pending_approval bills can be ${verb}d (this one is ${bill.status}).`
    );
  }
  // Re-resolve against CURRENT thresholds — rules may have changed since
  // the bill was submitted.
  const routing = await resolveApprovalRouting(
    ctx.tx,
    ctx.actor.organizationId,
    "ap_bill",
    bill.totalAmount
  );
  if (!canApproveAtRole(ctx.actor.role, routing.requiredRole)) {
    throw new AppError(
      "forbidden",
      `Role "${ctx.actor.role}" can't ${verb} this bill: "${routing.requiredRole}" or higher is required for ${money(bill.totalAmount).toFixed(2)}.`,
      { requiredRole: routing.requiredRole }
    );
  }
  if (ctx.actor.agentId && bill.createdByAgentId === ctx.actor.agentId) {
    throw new AppError(
      "forbidden",
      `An agent can't ${verb} a bill it created. A human or another approver must review it.`
    );
  }
  return routing;
}

export async function approveBill(ctx: Ctx, input: { id: string }): Promise<BillDetail> {
  const { id: billId } = BillIdSchema.parse(input);
  const bill = await loadBill(ctx, billId, true);
  const routing = await requireApprover(ctx, bill, "approve");

  await ctx.tx
    .update(apBills)
    .set({
      status: "approved",
      approvedAt: sql`now()`,
      approvedBy: ctx.actor.userId,
      approvalThresholdId: routing.threshold?.id ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(apBills.id, billId));

  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.bill.approved",
      entityType: "ap_bill",
      entityId: billId,
      metadata: {
        billNumber: bill.billNumber,
        total: bill.totalAmount,
        approverRole: ctx.actor.role,
        requiredRole: routing.requiredRole,
      },
    },
    ctx.tx
  );
  return getBill(ctx, { id: billId });
}

export async function rejectBill(
  ctx: Ctx,
  input: z.input<typeof ReasonSchema>
): Promise<BillDetail> {
  const { id: billId, reason } = ReasonSchema.parse(input);
  const bill = await loadBill(ctx, billId, true);
  await requireApprover(ctx, bill, "reject");

  await ctx.tx
    .update(apBills)
    .set({
      status: "rejected",
      rejectedAt: sql`now()`,
      rejectedBy: ctx.actor.userId,
      rejectionReason: reason,
      updatedAt: sql`now()`,
    })
    .where(eq(apBills.id, billId));

  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.bill.rejected",
      entityType: "ap_bill",
      entityId: billId,
      metadata: { billNumber: bill.billNumber, reason, rejectorRole: ctx.actor.role },
    },
    ctx.tx
  );
  return getBill(ctx, { id: billId });
}

export async function postBill(ctx: Ctx, input: { id: string }): Promise<BillDetail> {
  requirePermission(ctx.actor, "post", "accountant", "post bills to the ledger");
  const { id: billId } = BillIdSchema.parse(input);
  const bill = await loadBill(ctx, billId, true);
  if (bill.status !== "approved") {
    throw invalidState(`Only approved bills can be posted (this one is ${bill.status}).`);
  }
  requirePostingWithinLimit(
    ctx.actor,
    money(bill.totalAmount).times(money(bill.exchangeRate)),
    `Bill ${bill.billNumber}`
  );

  const { journalId } = await postBillToGl(ctx, bill);
  await ctx.tx
    .update(apBills)
    .set({
      status: "posted",
      postedAt: sql`now()`,
      postedBy: ctx.actor.userId,
      postingDate: bill.postingDate ?? bill.billDate,
      glJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(apBills.id, billId));
  return getBill(ctx, { id: billId });
}

export async function voidBill(
  ctx: Ctx,
  input: z.input<typeof ReasonSchema>
): Promise<BillDetail> {
  requirePermission(ctx.actor, "post", "admin", "void bills");
  const { id: billId, reason } = ReasonSchema.parse(input);
  const bill = await loadBill(ctx, billId, true);
  if (bill.status !== "posted") {
    throw invalidState(
      `Only posted bills can be voided (this one is ${bill.status}). Use edit or reject for earlier states.`
    );
  }
  const applied = await billAppliedTotal(ctx.tx, billId);
  if (applied.gt(0)) {
    throw invalidState(
      `Bill ${bill.billNumber} has ${applied.toFixed(2)} in posted payments and vendor credits. Void those payments and unapply the credits first.`
    );
  }

  const { journalId } = await voidBillFromGl(ctx, bill, reason);
  await ctx.tx
    .update(apBills)
    .set({
      status: "voided",
      voidedAt: sql`now()`,
      voidedBy: ctx.actor.userId,
      voidReason: reason,
      voidGlJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(apBills.id, billId));
  if (bill.purchaseOrderId) await syncPurchaseOrderStatus(ctx, bill.purchaseOrderId, { reopen: true });
  return getBill(ctx, { id: billId });
}

/** What role will approving a bill of this amount require? */
export async function previewBillApproval(
  ctx: Ctx,
  input: { amount: string }
): Promise<{ requiredRole: string; tierName: string | null; fallback: boolean }> {
  requirePermission(ctx.actor, "read", "viewer", "preview approval routing");
  const amt = amount.parse(input.amount);
  const routing = await resolveApprovalRouting(
    ctx.tx,
    ctx.actor.organizationId,
    "ap_bill",
    amt
  );
  return {
    requiredRole: routing.requiredRole,
    tierName: routing.threshold?.tierName ?? null,
    fallback: routing.fallback,
  };
}

/** Bills that a set of ids resolves to, scoped to the org. */
export async function loadBillsByIds(ctx: Ctx, ids: string[]): Promise<ApBill[]> {
  if (ids.length === 0) return [];
  return ctx.tx
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.organizationId, ctx.actor.organizationId), inArray(apBills.id, ids))
    );
}

/** Discard a draft or rejected bill (no ledger impact yet). */
export async function deleteDraftBill(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft bills");
  const { id: billId } = BillIdSchema.parse(input);
  const bill = await loadBill(ctx, billId, true);
  if (bill.status !== "draft" && bill.status !== "rejected") {
    throw invalidState(`Only draft or rejected bills can be deleted (this one is ${bill.status}).`);
  }
  await ctx.tx.delete(apBills).where(eq(apBills.id, billId));
  if (bill.purchaseOrderId) await syncPurchaseOrderStatus(ctx, bill.purchaseOrderId, { reopen: true });
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.bill.deleted",
      entityType: "ap_bill",
      entityId: billId,
      metadata: { billNumber: bill.billNumber },
    },
    ctx.tx
  );
  return { id: billId };
}
