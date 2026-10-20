import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { paymentMethod, vendorRefunds, vendors, type VendorRefund } from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { requireBankingAccount } from "@/lib/banking/common";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { controlAccount, sourceCodeId } from "@/lib/gl/lookups";
import { createAndPostJournal, reverseJournal } from "@/lib/gl/posting";
import { money } from "@/lib/money";
import { requireActiveVendor } from "@/lib/parties/service";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import { amount, currency, id, isoDate, optionalText, pagination, positiveAmount, toPage, type Page } from "@/lib/schemas";
import {
  applyVendorCreditsToRefund,
  openVendorCredits,
  planVendorCreditUse,
  releaseVendorCreditApplications,
  usesOfVendorCredit,
} from "./credits";

/**
 * VENDOR REFUNDS: money a vendor sends back to pay out a credit. Posting:
 * Dr the bank (or card) / Cr AP, and the refund takes that much vendor
 * credit (the named credit, or the oldest first). Voiding gives the credit
 * back.
 */

export const CreateVendorRefundSchema = z.object({
  vendorId: id,
  refundDate: isoDate,
  method: z.enum(paymentMethod.enumValues),
  reference: optionalText(100).describe("Check number or confirmation from the vendor."),
  bankAccountId: id.describe("Bank, cash, or credit card account the money comes back to."),
  amount: positiveAmount,
  vendorCreditId: id.optional().describe("The credit being refunded. Omit to use the vendor's oldest credits first."),
  currency: currency.optional(),
  exchangeRate: amount.optional(),
  memo: optionalText(500),
  post: z.boolean().optional().describe("Post in the same call."),
});
export type CreateVendorRefundInput = z.input<typeof CreateVendorRefundSchema>;

export const ListVendorRefundsSchema = z.object({
  status: z.enum(["draft", "posted", "voided"]).optional(),
  vendorId: id.optional(),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type VendorRefundRow = VendorRefund & { vendorName: string };
export type VendorRefundDetail = VendorRefundRow & {
  credits: Awaited<ReturnType<typeof usesOfVendorCredit>>;
};

export async function listVendorRefunds(ctx: Ctx, input: z.input<typeof ListVendorRefundsSchema>): Promise<Page<VendorRefundRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list vendor refunds");
  const f = ListVendorRefundsSchema.parse(input);
  const rows = await ctx.tx
    .select({ r: vendorRefunds, vendorName: vendors.name })
    .from(vendorRefunds)
    .innerJoin(vendors, eq(vendors.id, vendorRefunds.vendorId))
    .where(
      and(
        eq(vendorRefunds.organizationId, ctx.actor.organizationId),
        isNull(vendorRefunds.deletedAt),
        f.status ? eq(vendorRefunds.status, f.status) : undefined,
        f.vendorId ? eq(vendorRefunds.vendorId, f.vendorId) : undefined
      )
    )
    .orderBy(desc(vendorRefunds.refundDate), desc(vendorRefunds.refundNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map((r) => ({ ...r.r, vendorName: r.vendorName })), f.limit, f.offset);
}

export async function getVendorRefund(ctx: Ctx, input: { id: string }): Promise<VendorRefundDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view vendor refunds");
  const { id: refundId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select({ r: vendorRefunds, vendorName: vendors.name })
    .from(vendorRefunds)
    .innerJoin(vendors, eq(vendors.id, vendorRefunds.vendorId))
    .where(and(eq(vendorRefunds.id, refundId), eq(vendorRefunds.organizationId, ctx.actor.organizationId), isNull(vendorRefunds.deletedAt)));
  if (!row) throw notFound("Vendor refund");
  return { ...row.r, vendorName: row.vendorName, credits: await usesOfVendorCredit(ctx, { vendorRefundId: refundId }) };
}

async function loadRefund(ctx: Ctx, refundId: string): Promise<VendorRefund> {
  const [r] = await ctx.tx
    .select()
    .from(vendorRefunds)
    .where(and(eq(vendorRefunds.id, refundId), eq(vendorRefunds.organizationId, ctx.actor.organizationId), isNull(vendorRefunds.deletedAt)))
    .for("update");
  if (!r) throw notFound("Vendor refund");
  return r;
}

export async function createVendorRefund(ctx: Ctx, input: CreateVendorRefundInput): Promise<VendorRefundDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record vendor refunds");
  const d = CreateVendorRefundSchema.parse(input);
  const org = ctx.actor.organizationId;
  const vendor = await requireActiveVendor(ctx, d.vendorId);
  await requireBankingAccount(ctx.tx, org, d.bankAccountId, { label: "Refund account" });
  // Check now that the credit is there; posting takes it.
  await planVendorCreditUse(ctx, vendor.id, d.amount, d.vendorCreditId);
  const refundNumber = await nextNumber(ctx.tx, org, "VR");
  const [r] = await ctx.tx
    .insert(vendorRefunds)
    .values({
      organizationId: org,
      refundNumber,
      vendorId: vendor.id,
      refundDate: d.refundDate,
      method: d.method,
      reference: d.reference,
      bankAccountId: d.bankAccountId,
      currency: d.currency ?? vendor.currency,
      exchangeRate: d.exchangeRate ?? "1",
      amount: d.amount,
      vendorCreditId: d.vendorCreditId ?? null,
      memo: d.memo,
      status: "draft",
      ...creatorFields(ctx.actor),
    })
    .returning();
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.vendor_refund.created",
      entityType: "vendor_refund",
      entityId: r.id,
      metadata: { refundNumber, vendorId: vendor.id, amount: r.amount, vendorCreditId: r.vendorCreditId },
    },
    ctx.tx
  );
  if (d.post) {
    return postOrQueueForReview(ctx, (cx) => postVendorRefund(cx, { id: r.id }), () => getVendorRefund(ctx, { id: r.id }));
  }
  return getVendorRefund(ctx, { id: r.id });
}

export async function postVendorRefund(ctx: Ctx, input: { id: string }): Promise<VendorRefundDetail> {
  requirePermission(ctx.actor, "post", "accountant", "post vendor refunds");
  const { id: refundId } = IdSchema.parse(input);
  const r = await loadRefund(ctx, refundId);
  if (r.status !== "draft") throw invalidState(`Only draft vendor refunds can be posted (this one is ${r.status}).`);
  requirePostingWithinLimit(ctx.actor, money(r.amount).times(money(r.exchangeRate)), `Vendor refund ${r.refundNumber}`);
  const org = ctx.actor.organizationId;
  const plan = await planVendorCreditUse(ctx, r.vendorId, r.amount, r.vendorCreditId);
  await requireBankingAccount(ctx.tx, org, r.bankAccountId, { label: "Refund account" });
  const ap = await controlAccount(ctx.tx, org, "payables");
  const label = `Vendor refund ${r.refundNumber}`;
  const result = await createAndPostJournal(
    {
      organizationId: org,
      actorId: ctx.actor.userId,
      actor: ctx.actor,
      journalDate: r.refundDate,
      sourceCodeId: await sourceCodeId(ctx.tx, org, "CR"),
      source: "cash_receipt",
      description: label,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      documentNo: r.reference ?? r.refundNumber,
      lines: [
        {
          accountId: r.bankAccountId,
          debit: r.amount,
          memo: `${label} · ${r.method}${r.reference ? ` ref ${r.reference}` : ""}`,
          vendorId: r.vendorId,
          bankAccountId: r.bankAccountId,
        },
        { accountId: ap.id, credit: r.amount, memo: label, vendorId: r.vendorId },
      ],
    },
    ctx.tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  await ctx.tx
    .update(vendorRefunds)
    .set({ status: "posted", postedAt: sql`now()`, postedBy: ctx.actor.userId, glJournalId: result.journalId, updatedAt: sql`now()` })
    .where(eq(vendorRefunds.id, r.id));
  await applyVendorCreditsToRefund(ctx, r.id, r.vendorId, r.refundDate, plan);
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.vendor_refund.posted",
      entityType: "vendor_refund",
      entityId: r.id,
      metadata: { refundNumber: r.refundNumber, journalId: result.journalId, amount: r.amount },
    },
    ctx.tx
  );
  return getVendorRefund(ctx, { id: r.id });
}

export async function voidVendorRefund(ctx: Ctx, input: z.input<typeof VoidSchema>): Promise<VendorRefundDetail> {
  requirePermission(ctx.actor, "post", "admin", "void vendor refunds");
  const { id: refundId, reason } = VoidSchema.parse(input);
  const r = await loadRefund(ctx, refundId);
  if (r.status !== "posted" || !r.glJournalId) throw invalidState(`Only posted vendor refunds can be voided (this one is ${r.status}).`);
  await releaseVendorCreditApplications(ctx, { vendorRefundId: r.id }, `Vendor refund ${r.refundNumber}`);
  const result = await reverseJournal(
    r.glJournalId,
    { actorId: ctx.actor.userId, actor: ctx.actor, organizationId: ctx.actor.organizationId, description: `Void of vendor refund ${r.refundNumber}: ${reason}` },
    ctx.tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  await ctx.tx
    .update(vendorRefunds)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId: result.journalId, updatedAt: sql`now()` })
    .where(eq(vendorRefunds.id, r.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.vendor_refund.voided",
      entityType: "vendor_refund",
      entityId: r.id,
      metadata: { refundNumber: r.refundNumber, reason, reversalJournalId: result.journalId },
    },
    ctx.tx
  );
  return getVendorRefund(ctx, { id: r.id });
}

export async function deleteDraftVendorRefund(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft vendor refunds");
  const { id: refundId } = IdSchema.parse(input);
  const r = await loadRefund(ctx, refundId);
  if (r.status !== "draft") throw invalidState(`Only drafts can be deleted (this one is ${r.status}). Void it instead.`);
  await ctx.tx.delete(vendorRefunds).where(eq(vendorRefunds.id, r.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.vendor_refund.deleted",
      entityType: "vendor_refund",
      entityId: r.id,
      metadata: { refundNumber: r.refundNumber },
    },
    ctx.tx
  );
  return { id: r.id };
}

/** Vendors with credit to refund, for the new refund form. */
export async function vendorCreditsForRefund(ctx: Ctx, vendorId: string) {
  requirePermission(ctx.actor, "read", "viewer", "view vendor credits");
  return openVendorCredits(ctx, vendorId);
}
