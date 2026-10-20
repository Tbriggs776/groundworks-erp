import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  customers,
  items,
  paymentMethod,
  refundReceiptLines,
  refundReceipts,
  type RefundReceipt,
  type RefundReceiptLine,
  type SalesTaxLine,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { requireBankingAccount } from "@/lib/banking/common";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { createAndPostJournal } from "@/lib/gl/posting";
import { controlAccount, sourceCodeId } from "@/lib/gl/lookups";
import { nextNumber } from "@/lib/gl/number-series";
import { money, toDbMoney } from "@/lib/money";
import { requireActiveCustomer } from "@/lib/parties/service";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import { amount, currency, id, isoDate, likePattern, optionalText, pagination, positiveAmount, toPage, type Page } from "@/lib/schemas";
import { applyCreditsToRefund, planCreditUse, releaseCreditApplications } from "./credits";
import {
  documentTotals,
  postSalesDocument,
  resolveSalesLines,
  reverseSalesDocument,
  SalesLineSchema,
  taxCodeField,
  taxLinesOf,
  totalsColumns,
  writeTaxLines,
  type ResolvedLine,
} from "./documents";
import { withAgencyNames } from "./sales-receipts";

/**
 * REFUND RECEIPTS: money paid back to a customer. Lifecycle draft → posted
 * → voided. Two kinds:
 *
 *   items   returned goods or services, with lines and sales tax:
 *           Dr income, Dr sales tax / Cr bank
 *   credit  pays out the customer's credit balance (a credit memo or an
 *           overpayment): Dr AR / Cr bank, and uses up that credit
 */

const Common = {
  customerId: id,
  refundDate: isoDate.describe("Refund date; also the posting date."),
  method: z.enum(paymentMethod.enumValues),
  reference: optionalText(100).describe("Check number or confirmation."),
  bankAccountId: id.describe("Bank, cash, or credit card account the money leaves."),
  currency: currency.optional(),
  exchangeRate: amount.optional(),
  memo: optionalText(2000),
  privateNote: optionalText(2000),
  post: z.boolean().optional().describe("Post to the ledger in the same call."),
};

export const CreateRefundSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("items").describe("Refund for returned items: lines (and tax) like an invoice."),
    ...Common,
    taxCodeId: taxCodeField,
    lines: z.array(SalesLineSchema).min(1, "A refund needs at least 1 line."),
  }),
  z.object({
    kind: z.literal("credit").describe("Pay out the customer's credit balance."),
    ...Common,
    amount: positiveAmount,
    creditMemoId: id.optional().describe("The credit memo to pay out. Omit both this and paymentId to use the oldest credits first."),
    paymentId: id.optional().describe("Or the overpaid payment to pay out."),
  }),
]);
export type CreateRefundInput = z.input<typeof CreateRefundSchema>;

export const ListRefundsSchema = z.object({
  status: z.enum(["draft", "posted", "voided"]).optional(),
  customerId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional(),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type RefundRow = RefundReceipt & { customerName: string; bankAccountName: string };
export type RefundDetail = RefundRow & {
  lines: Array<RefundReceiptLine & { itemName: string | null }>;
  taxLines: Array<SalesTaxLine & { agencyName: string }>;
};

function rowSelect() {
  return { r: refundReceipts, customerName: customers.name, bankAccountName: accounts.name };
}

export async function listRefunds(ctx: Ctx, input: z.input<typeof ListRefundsSchema>): Promise<Page<RefundRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list refunds");
  const f = ListRefundsSchema.parse(input);
  const rows = await ctx.tx
    .select(rowSelect())
    .from(refundReceipts)
    .innerJoin(customers, eq(customers.id, refundReceipts.customerId))
    .innerJoin(accounts, eq(accounts.id, refundReceipts.bankAccountId))
    .where(
      and(
        eq(refundReceipts.organizationId, ctx.actor.organizationId),
        isNull(refundReceipts.deletedAt),
        f.status ? eq(refundReceipts.status, f.status) : undefined,
        f.customerId ? eq(refundReceipts.customerId, f.customerId) : undefined,
        f.from ? gte(refundReceipts.refundDate, f.from) : undefined,
        f.to ? lte(refundReceipts.refundDate, f.to) : undefined,
        f.q ? or(ilike(refundReceipts.refundNumber, likePattern(f.q)), ilike(refundReceipts.reference, likePattern(f.q)), ilike(customers.name, likePattern(f.q))) : undefined
      )
    )
    .orderBy(desc(refundReceipts.refundDate), desc(refundReceipts.refundNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map((x) => ({ ...x.r, customerName: x.customerName, bankAccountName: x.bankAccountName })), f.limit, f.offset);
}

export async function getRefund(ctx: Ctx, input: { id: string }): Promise<RefundDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view refunds");
  const { id: refundId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select(rowSelect())
    .from(refundReceipts)
    .innerJoin(customers, eq(customers.id, refundReceipts.customerId))
    .innerJoin(accounts, eq(accounts.id, refundReceipts.bankAccountId))
    .where(and(eq(refundReceipts.id, refundId), eq(refundReceipts.organizationId, ctx.actor.organizationId), isNull(refundReceipts.deletedAt)));
  if (!row) throw notFound("Refund");
  const lines = await ctx.tx
    .select({ line: refundReceiptLines, itemName: items.name })
    .from(refundReceiptLines)
    .leftJoin(items, eq(items.id, refundReceiptLines.itemId))
    .where(eq(refundReceiptLines.refundId, refundId))
    .orderBy(asc(refundReceiptLines.lineNumber));
  return {
    ...row.r,
    customerName: row.customerName,
    bankAccountName: row.bankAccountName,
    lines: lines.map((l) => ({ ...l.line, itemName: l.itemName })),
    taxLines: await withAgencyNames(ctx, await taxLinesOf(ctx, { refundId })),
  };
}

async function loadRefund(ctx: Ctx, refundId: string): Promise<RefundReceipt> {
  const [r] = await ctx.tx
    .select()
    .from(refundReceipts)
    .where(and(eq(refundReceipts.id, refundId), eq(refundReceipts.organizationId, ctx.actor.organizationId), isNull(refundReceipts.deletedAt)))
    .for("update");
  if (!r) throw notFound("Refund");
  return r;
}

async function insertLines(ctx: Ctx, refundId: string, lines: ResolvedLine[]) {
  await ctx.tx
    .insert(refundReceiptLines)
    .values(lines.map((l, i) => ({ organizationId: ctx.actor.organizationId, refundId, lineNumber: i + 1, ...l })));
}

const creditSource = (r: Pick<RefundReceipt, "creditMemoId" | "paymentId" | "totalAmount">) =>
  r.creditMemoId || r.paymentId
    ? [{ creditMemoId: r.creditMemoId ?? undefined, paymentId: r.paymentId ?? undefined, amount: r.totalAmount }]
    : undefined;

export async function createRefund(ctx: Ctx, input: CreateRefundInput): Promise<RefundDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record refunds");
  const d = CreateRefundSchema.parse(input);
  const org = ctx.actor.organizationId;
  const customer = await requireActiveCustomer(ctx, d.customerId);
  await requireBankingAccount(ctx.tx, org, d.bankAccountId, { label: "Refund-from account" });
  const header = {
    organizationId: org,
    customerId: customer.id,
    refundDate: d.refundDate,
    kind: d.kind,
    method: d.method,
    reference: d.reference,
    bankAccountId: d.bankAccountId,
    currency: d.currency ?? customer.currency,
    exchangeRate: d.exchangeRate ?? "1",
    memo: d.memo,
    privateNote: d.privateNote,
    status: "draft" as const,
    ...creatorFields(ctx.actor),
  };
  let refund: RefundReceipt;
  if (d.kind === "items") {
    const lines = await resolveSalesLines(ctx, d.lines);
    const totals = await documentTotals(ctx, { customer, taxCodeId: d.taxCodeId, lines });
    [refund] = await ctx.tx
      .insert(refundReceipts)
      .values({ ...header, refundNumber: await nextNumber(ctx.tx, org, "RR"), ...totalsColumns(totals) })
      .returning();
    await insertLines(ctx, refund.id, lines);
    await writeTaxLines(ctx, { refundId: refund.id }, totals);
  } else {
    if (d.creditMemoId && d.paymentId) throw new AppError("invalid_input", "Give creditMemoId or paymentId, not both.");
    const total = toDbMoney(money(d.amount));
    // Check there's enough credit now; it's taken when the refund posts.
    await planCreditUse(ctx, customer.id, total, creditSource({ creditMemoId: d.creditMemoId ?? null, paymentId: d.paymentId ?? null, totalAmount: total }));
    [refund] = await ctx.tx
      .insert(refundReceipts)
      .values({
        ...header,
        refundNumber: await nextNumber(ctx.tx, org, "RR"),
        creditMemoId: d.creditMemoId ?? null,
        paymentId: d.paymentId ?? null,
        subtotalAmount: total,
        totalAmount: total,
      })
      .returning();
  }
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ar.refund.created",
      entityType: "refund_receipt",
      entityId: refund.id,
      metadata: { refundNumber: refund.refundNumber, kind: refund.kind, customerId: customer.id, total: refund.totalAmount },
    },
    ctx.tx
  );
  if (d.post) {
    return postOrQueueForReview(ctx, (c) => postRefund(c, { id: refund.id }), () => getRefund(ctx, { id: refund.id }));
  }
  return getRefund(ctx, { id: refund.id });
}

export async function postRefund(ctx: Ctx, input: { id: string }): Promise<RefundDetail> {
  requirePermission(ctx.actor, "post", "bookkeeper", "post refunds");
  const { id: refundId } = IdSchema.parse(input);
  const r = await loadRefund(ctx, refundId);
  if (r.status !== "draft") throw invalidState(`Only draft refunds can be posted (this one is ${r.status}).`);
  requirePostingWithinLimit(ctx.actor, money(r.totalAmount).times(money(r.exchangeRate)), `Refund ${r.refundNumber}`);
  const org = ctx.actor.organizationId;
  let journalId: string;
  if (r.kind === "items") {
    const lines = await ctx.tx.select().from(refundReceiptLines).where(eq(refundReceiptLines.refundId, r.id)).orderBy(asc(refundReceiptLines.lineNumber));
    ({ journalId } = await postSalesDocument(ctx, {
      direction: "return",
      ref: { refundId: r.id },
      number: r.refundNumber,
      label: `Refund ${r.refundNumber}`,
      date: r.refundDate,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      total: r.totalAmount,
      customerId: r.customerId,
      counter: { accountId: r.bankAccountId, bank: true, memo: `Refund ${r.refundNumber} · ${r.method}${r.reference ? ` ref ${r.reference}` : ""}` },
      lines,
      sourceCode: "CD",
      source: "cash_disbursement",
      auditEvent: "ar.refund.posted",
      entityType: "refund_receipt",
      entityId: r.id,
    }));
  } else {
    const plan = await planCreditUse(ctx, r.customerId, r.totalAmount, creditSource(r));
    const ar = await controlAccount(ctx.tx, org, "receivables");
    const result = await createAndPostJournal(
      {
        organizationId: org,
        actorId: ctx.actor.userId,
        actor: ctx.actor,
        journalDate: r.refundDate,
        sourceCodeId: await sourceCodeId(ctx.tx, org, "CD"),
        source: "cash_disbursement",
        description: `Credit refund ${r.refundNumber}`,
        currency: r.currency,
        exchangeRate: r.exchangeRate,
        documentNo: r.reference ?? r.refundNumber,
        lines: [
          { accountId: ar.id, debit: r.totalAmount, memo: `Credit refund ${r.refundNumber}`, customerId: r.customerId },
          {
            accountId: r.bankAccountId,
            credit: r.totalAmount,
            memo: `Credit refund ${r.refundNumber} · ${r.method}${r.reference ? ` ref ${r.reference}` : ""}`,
            customerId: r.customerId,
            bankAccountId: r.bankAccountId,
          },
        ],
      },
      ctx.tx
    );
    if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
    journalId = result.journalId;
    await applyCreditsToRefund(ctx, r.id, r.customerId, r.refundDate, plan);
    await writeAudit(
      {
        organizationId: org,
        ...auditFields(ctx.actor),
        event: "ar.refund.posted",
        entityType: "refund_receipt",
        entityId: r.id,
        metadata: { number: r.refundNumber, journalId, total: r.totalAmount, credits: plan.map((p) => ({ credit: p.credit.number, amount: p.amount })) },
      },
      ctx.tx
    );
  }
  await ctx.tx
    .update(refundReceipts)
    .set({ status: "posted", postedAt: sql`now()`, postedBy: ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(refundReceipts.id, r.id));
  return getRefund(ctx, { id: r.id });
}

export async function voidRefund(ctx: Ctx, input: z.input<typeof VoidSchema>): Promise<RefundDetail> {
  requirePermission(ctx.actor, "post", "admin", "void refunds");
  const { id: refundId, reason } = VoidSchema.parse(input);
  const r = await loadRefund(ctx, refundId);
  if (r.status !== "posted") throw invalidState(`Only posted refunds can be voided (this one is ${r.status}).`);
  // A credit refund gives the credit back to the customer.
  await releaseCreditApplications(ctx, { refundId: r.id }, `Refund ${r.refundNumber}`);
  const { journalId } = await reverseSalesDocument(ctx, {
    glJournalId: r.glJournalId,
    label: `refund ${r.refundNumber}`,
    reason,
    auditEvent: "ar.refund.voided",
    entityType: "refund_receipt",
    entityId: r.id,
    number: r.refundNumber,
  });
  await ctx.tx
    .update(refundReceipts)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(refundReceipts.id, r.id));
  return getRefund(ctx, { id: r.id });
}

export async function deleteDraftRefund(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft refunds");
  const { id: refundId } = IdSchema.parse(input);
  const r = await loadRefund(ctx, refundId);
  if (r.status !== "draft") throw invalidState(`Only drafts can be deleted (this one is ${r.status}). Void it instead.`);
  await ctx.tx.delete(refundReceipts).where(eq(refundReceipts.id, r.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.refund.deleted",
      entityType: "refund_receipt",
      entityId: r.id,
      metadata: { refundNumber: r.refundNumber },
    },
    ctx.tx
  );
  return { id: r.id };
}
