import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  apBills,
  apPaymentApplications,
  apPayments,
  paymentMethod,
  vendors,
  type ApPayment,
  type ApPaymentApplication,
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
import { requireBankingAccount } from "@/lib/banking/common";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import {
  amount,
  currency,
  id,
  isoDate,
  optionalText,
  pagination,
  nonNegativeAmount,
  positiveAmount,
  toPage,
  type Page,
} from "@/lib/schemas";
import { assertPrintLater } from "./checks";
import {
  billAppliedTotal,
  postPaymentToGl,
  recomputeBillPaymentStatus,
  voidPaymentFromGl,
} from "./payments";

/**
 * BILL PAYMENTS (AP) — money out against posted bills. One payment can
 * settle several bills of the same vendor; one bill can be paid across
 * several payments. Lifecycle: draft → posted → voided.
 */

const ApplicationSchema = z.object({
  billId: id,
  amount: positiveAmount.describe(
    "Cash applied to this bill: what actually leaves the bank for it."
  ),
  discountAmount: nonNegativeAmount
    .optional()
    .describe(
      "Early-pay discount taken on this bill, on top of `amount`. The bill's open balance drops by amount + discount."
    ),
});

export const CreateBillPaymentSchema = z.object({
  vendorId: id,
  paymentDate: isoDate,
  method: z.enum(paymentMethod.enumValues),
  reference: optionalText(100).describe("Check number, ACH trace, or confirmation #."),
  bankAccountId: id.describe("Bank, cash, or credit card account the money leaves from. Paying with a card adds to the card's balance."),
  printLater: z
    .boolean()
    .optional()
    .describe("Method check from a bank account: put it in the check print queue (print_checks gives it a number). Leave reference empty."),
  currency: currency.optional(),
  exchangeRate: amount.optional(),
  memo: optionalText(500),
  applications: z.array(ApplicationSchema).min(1, "A payment must apply to at least one bill."),
  post: z
    .boolean()
    .optional()
    .describe("Also post the payment to the ledger in the same call."),
});
export type CreateBillPaymentInput = z.input<typeof CreateBillPaymentSchema>;

export const ListBillPaymentsSchema = z.object({
  status: z.enum(["draft", "posted", "voided"]).optional(),
  vendorId: id.optional(),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({
  id,
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

export type BillPaymentRow = ApPayment & { vendorName: string };
export type BillPaymentDetail = BillPaymentRow & {
  applications: Array<ApPaymentApplication & { billNumber: string }>;
};

export async function listBillPayments(
  ctx: Ctx,
  input: z.input<typeof ListBillPaymentsSchema>
): Promise<Page<BillPaymentRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list bill payments");
  const f = ListBillPaymentsSchema.parse(input);
  const rows = await ctx.tx
    .select({ payment: apPayments, vendorName: vendors.name })
    .from(apPayments)
    .innerJoin(vendors, eq(vendors.id, apPayments.vendorId))
    .where(
      and(
        eq(apPayments.organizationId, ctx.actor.organizationId),
        isNull(apPayments.deletedAt),
        f.status ? eq(apPayments.status, f.status) : undefined,
        f.vendorId ? eq(apPayments.vendorId, f.vendorId) : undefined
      )
    )
    .orderBy(desc(apPayments.paymentDate), desc(apPayments.paymentNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.payment, vendorName: r.vendorName })),
    f.limit,
    f.offset
  );
}

export async function getBillPayment(
  ctx: Ctx,
  input: { id: string }
): Promise<BillPaymentDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view bill payments");
  const { id: paymentId } = IdSchema.parse(input);
  const payment = await loadPayment(ctx, paymentId);
  const [vendor] = await ctx.tx
    .select({ name: vendors.name })
    .from(vendors)
    .where(eq(vendors.id, payment.vendorId));
  const applications = await ctx.tx
    .select({ app: apPaymentApplications, billNumber: apBills.billNumber })
    .from(apPaymentApplications)
    .innerJoin(apBills, eq(apBills.id, apPaymentApplications.billId))
    .where(eq(apPaymentApplications.paymentId, paymentId))
    .orderBy(asc(apBills.billNumber));
  return {
    ...payment,
    vendorName: vendor?.name ?? "",
    applications: applications.map((a) => ({ ...a.app, billNumber: a.billNumber })),
  };
}

async function loadPayment(ctx: Ctx, paymentId: string, forUpdate = false): Promise<ApPayment> {
  const q = ctx.tx
    .select()
    .from(apPayments)
    .where(
      and(
        eq(apPayments.id, paymentId),
        eq(apPayments.organizationId, ctx.actor.organizationId),
        isNull(apPayments.deletedAt)
      )
    );
  const [p] = forUpdate ? await q.for("update") : await q;
  if (!p) throw notFound("Bill payment");
  return p;
}

/**
 * Every application must target a posted bill of this vendor, and together
 * with already-posted payments must not exceed the bill total. Locks the
 * bills so two concurrent posts can't both squeeze through.
 */
async function assertApplicationsFit(
  ctx: Ctx,
  vendorId: string,
  applications: Array<{ billId: string; amount: string; discountAmount: string }>
) {
  const billIds = applications.map((a) => a.billId);
  if (new Set(billIds).size !== billIds.length) {
    throw new AppError("invalid_input", "Each bill may appear only once in a payment.");
  }
  const bills = await ctx.tx
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.organizationId, ctx.actor.organizationId), inArray(apBills.id, billIds))
    )
    .for("update");
  if (bills.length !== billIds.length) throw notFound("One or more bills");

  for (const a of applications) {
    const bill = bills.find((b) => b.id === a.billId)!;
    if (bill.vendorId !== vendorId) {
      throw new AppError("invalid_input", `Bill ${bill.billNumber} belongs to a different vendor.`);
    }
    if (bill.status !== "posted") {
      throw invalidState(
        `Bill ${bill.billNumber} is ${bill.status}; only posted bills with an open balance can be paid.`
      );
    }
    const prior = await billAppliedTotal(ctx.tx, bill.id);
    const open = money(bill.totalAmount).minus(prior);
    const reduction = money(a.amount).plus(money(a.discountAmount));
    if (reduction.gt(open)) {
      throw new AppError(
        "invalid_input",
        `Bill ${bill.billNumber} has only ${open.toFixed(2)} open; tried to apply ${reduction.toFixed(2)} (payment + discount).`,
        { billId: bill.id, openBalance: open.toFixed(2) }
      );
    }
  }
}

export async function createBillPayment(
  ctx: Ctx,
  input: CreateBillPaymentInput
): Promise<BillPaymentDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create bill payments");
  const data = CreateBillPaymentSchema.parse(input);
  const org = ctx.actor.organizationId;

  const [vendor] = await ctx.tx
    .select()
    .from(vendors)
    .where(and(eq(vendors.id, data.vendorId), eq(vendors.organizationId, org)));
  if (!vendor) throw notFound("Vendor");
  const bank = await requireBankingAccount(ctx.tx, org, data.bankAccountId, { label: "Payment account" });
  if (data.printLater) assertPrintLater(bank, { isCheck: data.method === "check", reference: data.reference });

  const apps = data.applications.map((a) => ({
    billId: a.billId,
    amount: a.amount,
    discountAmount: a.discountAmount ?? "0.0000",
  }));
  await assertApplicationsFit(ctx, data.vendorId, apps);

  // Header totals: gross applied = cash + discount; net = cash out.
  const net = sumMoney(apps.map((a) => a.amount));
  const discount = sumMoney(apps.map((a) => a.discountAmount));
  const applied = net.plus(discount);
  const paymentNumber = await nextNumber(ctx.tx, org, "APPAY");

  const [payment] = await ctx.tx
    .insert(apPayments)
    .values({
      organizationId: org,
      paymentNumber,
      vendorId: data.vendorId,
      paymentDate: data.paymentDate,
      method: data.method,
      reference: data.reference,
      toPrint: data.printLater ?? false,
      bankAccountId: data.bankAccountId,
      currency: data.currency ?? vendor.currency,
      exchangeRate: data.exchangeRate ?? "1",
      appliedAmount: toDbMoney(applied),
      discountAmount: toDbMoney(discount),
      netAmount: toDbMoney(net),
      memo: data.memo,
      status: "draft",
      ...creatorFields(ctx.actor),
    })
    .returning();

  await ctx.tx.insert(apPaymentApplications).values(
    apps.map((a) => ({
      organizationId: org,
      paymentId: payment.id,
      billId: a.billId,
      appliedAmount: a.amount,
      discountAmount: a.discountAmount,
    }))
  );

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.payment.created",
      entityType: "ap_payment",
      entityId: payment.id,
      metadata: {
        paymentNumber,
        vendorId: data.vendorId,
        applied: toDbMoney(applied),
        discount: toDbMoney(discount),
        billCount: apps.length,
      },
    },
    ctx.tx
  );

  if (data.post) {
    return postOrQueueForReview(
      ctx,
      (c) => postBillPayment(c, { id: payment.id }),
      () => getBillPayment(ctx, { id: payment.id })
    );
  }
  return getBillPayment(ctx, { id: payment.id });
}

export async function postBillPayment(
  ctx: Ctx,
  input: { id: string }
): Promise<BillPaymentDetail> {
  requirePermission(ctx.actor, "post", "accountant", "post bill payments");
  const { id: paymentId } = IdSchema.parse(input);
  const payment = await loadPayment(ctx, paymentId, true);
  if (payment.status !== "draft") {
    throw invalidState(`Only draft payments can be posted (this one is ${payment.status}).`);
  }
  requirePostingWithinLimit(
    ctx.actor,
    money(payment.netAmount).times(money(payment.exchangeRate)),
    `Bill payment ${payment.paymentNumber}`
  );

  const apps = await ctx.tx
    .select()
    .from(apPaymentApplications)
    .where(eq(apPaymentApplications.paymentId, paymentId));
  // Other payments may have posted since this draft was created.
  await assertApplicationsFit(
    ctx,
    payment.vendorId,
    apps.map((a) => ({
      billId: a.billId,
      amount: a.appliedAmount,
      discountAmount: a.discountAmount,
    }))
  );

  const { journalId } = await postPaymentToGl(ctx, payment);
  await ctx.tx
    .update(apPayments)
    .set({
      status: "posted",
      postedAt: sql`now()`,
      postedBy: ctx.actor.userId,
      glJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(apPayments.id, paymentId));

  for (const a of apps) {
    await recomputeBillPaymentStatus(ctx.tx, ctx.actor.organizationId, a.billId);
  }
  return getBillPayment(ctx, { id: paymentId });
}

export async function voidBillPayment(
  ctx: Ctx,
  input: z.input<typeof VoidSchema>
): Promise<BillPaymentDetail> {
  requirePermission(ctx.actor, "post", "admin", "void bill payments");
  const { id: paymentId, reason } = VoidSchema.parse(input);
  const payment = await loadPayment(ctx, paymentId, true);
  if (payment.status !== "posted") {
    throw invalidState(`Only posted payments can be voided (this one is ${payment.status}).`);
  }

  const { journalId } = await voidPaymentFromGl(ctx, payment, reason);
  await ctx.tx
    .update(apPayments)
    .set({
      status: "voided",
      voidedAt: sql`now()`,
      voidedBy: ctx.actor.userId,
      voidReason: reason,
      voidGlJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(apPayments.id, paymentId));

  // A voided payment no longer counts, so bills may drop from paid to posted.
  const apps = await ctx.tx
    .select({ billId: apPaymentApplications.billId })
    .from(apPaymentApplications)
    .where(eq(apPaymentApplications.paymentId, paymentId));
  for (const a of apps) {
    await recomputeBillPaymentStatus(ctx.tx, ctx.actor.organizationId, a.billId);
  }
  return getBillPayment(ctx, { id: paymentId });
}

/** Delete a draft payment (no ledger impact yet). */
export async function deleteDraftBillPayment(
  ctx: Ctx,
  input: { id: string }
): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft bill payments");
  const { id: paymentId } = IdSchema.parse(input);
  const payment = await loadPayment(ctx, paymentId, true);
  if (payment.status !== "draft") {
    throw invalidState(`Only draft payments can be deleted (this one is ${payment.status}). Void it instead.`);
  }
  await ctx.tx.delete(apPayments).where(eq(apPayments.id, paymentId));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.payment.deleted",
      entityType: "ap_payment",
      entityId: paymentId,
      metadata: { paymentNumber: payment.paymentNumber },
    },
    ctx.tx
  );
  return { id: paymentId };
}
