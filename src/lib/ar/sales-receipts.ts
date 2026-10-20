import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankTransactionLines,
  bankTransactions,
  customers,
  items,
  paymentMethod,
  salesReceiptLines,
  salesReceipts,
  taxAgencies,
  type SalesReceipt,
  type SalesReceiptLine,
  type SalesTaxLine,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { requirePostingAccount } from "@/lib/gl/lookups";
import { money } from "@/lib/money";
import { requireActiveCustomer } from "@/lib/parties/service";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import { amount, currency, id, isoDate, likePattern, optionalText, pagination, toPage, type Page } from "@/lib/schemas";
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

/**
 * SALES RECEIPTS: a sale paid on the spot. Lifecycle draft → posted →
 * voided. Posting: Dr deposit account (total) / Cr income, Cr sales tax.
 * Money received into Undeposited Funds waits there for a bank deposit.
 */

export const CreateSalesReceiptSchema = z.object({
  customerId: id.optional().describe("Optional: a walk-in sale needn't name the customer."),
  receiptDate: isoDate.describe("Sale date; also the posting date."),
  method: z.enum(paymentMethod.enumValues),
  reference: optionalText(100).describe("Check #, card authorization, or confirmation."),
  depositAccountId: id
    .optional()
    .describe("Bank / cash account the money lands in. Defaults to 1250 Undeposited Funds."),
  currency: currency.optional(),
  exchangeRate: amount.optional(),
  taxCodeId: taxCodeField,
  memo: optionalText(2000).describe("Message shown to the customer."),
  privateNote: optionalText(2000),
  lines: z.array(SalesLineSchema).min(1, "A sales receipt needs at least 1 line."),
  post: z.boolean().optional().describe("Post to the ledger in the same call."),
});
export type CreateSalesReceiptInput = z.input<typeof CreateSalesReceiptSchema>;

export const ListSalesReceiptsSchema = z.object({
  status: z.enum(["draft", "posted", "voided"]).optional(),
  customerId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional().describe("Search number, reference, memo, or customer."),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type SalesReceiptRow = SalesReceipt & { customerName: string | null; depositAccountName: string };
export type SalesReceiptDetail = SalesReceiptRow & {
  lines: Array<SalesReceiptLine & { itemName: string | null }>;
  taxLines: Array<SalesTaxLine & { agencyName: string }>;
  depositedOn: { transactionId: string; txnNumber: string } | null;
};

function rowSelect() {
  return { r: salesReceipts, customerName: customers.name, depositAccountName: accounts.name };
}

export async function listSalesReceipts(ctx: Ctx, input: z.input<typeof ListSalesReceiptsSchema>): Promise<Page<SalesReceiptRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list sales receipts");
  const f = ListSalesReceiptsSchema.parse(input);
  const rows = await ctx.tx
    .select(rowSelect())
    .from(salesReceipts)
    .leftJoin(customers, eq(customers.id, salesReceipts.customerId))
    .innerJoin(accounts, eq(accounts.id, salesReceipts.depositAccountId))
    .where(
      and(
        eq(salesReceipts.organizationId, ctx.actor.organizationId),
        isNull(salesReceipts.deletedAt),
        f.status ? eq(salesReceipts.status, f.status) : undefined,
        f.customerId ? eq(salesReceipts.customerId, f.customerId) : undefined,
        f.from ? gte(salesReceipts.receiptDate, f.from) : undefined,
        f.to ? lte(salesReceipts.receiptDate, f.to) : undefined,
        f.q
          ? or(
              ilike(salesReceipts.receiptNumber, likePattern(f.q)),
              ilike(salesReceipts.reference, likePattern(f.q)),
              ilike(salesReceipts.memo, likePattern(f.q)),
              ilike(customers.name, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(desc(salesReceipts.receiptDate), desc(salesReceipts.receiptNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((x) => ({ ...x.r, customerName: x.customerName, depositAccountName: x.depositAccountName })),
    f.limit,
    f.offset
  );
}

export async function getSalesReceipt(ctx: Ctx, input: { id: string }): Promise<SalesReceiptDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view sales receipts");
  const { id: receiptId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select(rowSelect())
    .from(salesReceipts)
    .leftJoin(customers, eq(customers.id, salesReceipts.customerId))
    .innerJoin(accounts, eq(accounts.id, salesReceipts.depositAccountId))
    .where(and(eq(salesReceipts.id, receiptId), eq(salesReceipts.organizationId, ctx.actor.organizationId), isNull(salesReceipts.deletedAt)));
  if (!row) throw notFound("Sales receipt");
  const lines = await ctx.tx
    .select({ line: salesReceiptLines, itemName: items.name })
    .from(salesReceiptLines)
    .leftJoin(items, eq(items.id, salesReceiptLines.itemId))
    .where(eq(salesReceiptLines.receiptId, receiptId))
    .orderBy(asc(salesReceiptLines.lineNumber));
  const [deposit] = await ctx.tx
    .select({ transactionId: bankTransactions.id, txnNumber: bankTransactions.txnNumber })
    .from(bankTransactionLines)
    .innerJoin(bankTransactions, eq(bankTransactions.id, bankTransactionLines.transactionId))
    .where(and(eq(bankTransactionLines.salesReceiptId, receiptId), sql`${bankTransactions.status} <> 'voided'`, isNull(bankTransactions.deletedAt)));
  return {
    ...row.r,
    customerName: row.customerName,
    depositAccountName: row.depositAccountName,
    lines: lines.map((l) => ({ ...l.line, itemName: l.itemName })),
    taxLines: await withAgencyNames(ctx, await taxLinesOf(ctx, { salesReceiptId: receiptId })),
    depositedOn: deposit ?? null,
  };
}

export async function withAgencyNames(ctx: Ctx, lines: SalesTaxLine[]) {
  if (lines.length === 0) return [];
  const agencies = await ctx.tx
    .select({ id: taxAgencies.id, name: taxAgencies.name })
    .from(taxAgencies)
    .where(eq(taxAgencies.organizationId, ctx.actor.organizationId));
  const name = new Map(agencies.map((a) => [a.id, a.name]));
  return lines.map((l) => ({ ...l, agencyName: name.get(l.agencyId) ?? "" }));
}

async function loadReceipt(ctx: Ctx, receiptId: string): Promise<SalesReceipt> {
  const [r] = await ctx.tx
    .select()
    .from(salesReceipts)
    .where(and(eq(salesReceipts.id, receiptId), eq(salesReceipts.organizationId, ctx.actor.organizationId), isNull(salesReceipts.deletedAt)))
    .for("update");
  if (!r) throw notFound("Sales receipt");
  return r;
}

/** Default deposit account: 1250 Undeposited Funds, if the company has it. */
export async function undepositedFunds(ctx: Ctx): Promise<string> {
  const [row] = await ctx.tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, ctx.actor.organizationId), eq(accounts.code, "1250"), eq(accounts.isCash, true)));
  if (!row) throw new AppError("invalid_input", "depositAccountId is required (this company has no 1250 Undeposited Funds account).");
  return row.id;
}

async function insertLines(ctx: Ctx, receiptId: string, lines: ResolvedLine[]) {
  await ctx.tx
    .insert(salesReceiptLines)
    .values(lines.map((l, i) => ({ organizationId: ctx.actor.organizationId, receiptId, lineNumber: i + 1, ...l })));
}

export async function createSalesReceipt(
  ctx: Ctx,
  input: CreateSalesReceiptInput
): Promise<SalesReceiptDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record sales receipts");
  const d = CreateSalesReceiptSchema.parse(input);
  const org = ctx.actor.organizationId;
  const customer = d.customerId ? await requireActiveCustomer(ctx, d.customerId) : null;
  const depositAccountId = d.depositAccountId ?? (await undepositedFunds(ctx));
  await requirePostingAccount(ctx.tx, org, depositAccountId, { cash: true, label: "Deposit account" });
  const lines = await resolveSalesLines(ctx, d.lines);
  const totals = await documentTotals(ctx, { customer, taxCodeId: d.taxCodeId, lines });
  const receiptNumber = await nextNumber(ctx.tx, org, "SR");
  const [r] = await ctx.tx
    .insert(salesReceipts)
    .values({
      organizationId: org,
      receiptNumber,
      customerId: customer?.id ?? null,
      receiptDate: d.receiptDate,
      method: d.method,
      reference: d.reference,
      depositAccountId,
      currency: d.currency ?? customer?.currency ?? "USD",
      exchangeRate: d.exchangeRate ?? "1",
      ...totalsColumns(totals),
      memo: d.memo,
      privateNote: d.privateNote,
      status: "draft",
      ...creatorFields(ctx.actor),
    })
    .returning();
  await insertLines(ctx, r.id, lines);
  await writeTaxLines(ctx, { salesReceiptId: r.id }, totals);
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ar.sales_receipt.created",
      entityType: "sales_receipt",
      entityId: r.id,
      metadata: { receiptNumber, customerId: r.customerId, total: r.totalAmount, tax: r.taxAmount },
    },
    ctx.tx
  );
  if (d.post) {
    return postOrQueueForReview(ctx, (c) => postSalesReceipt(c, { id: r.id }), () => getSalesReceipt(ctx, { id: r.id }));
  }
  return getSalesReceipt(ctx, { id: r.id });
}

export async function postSalesReceipt(ctx: Ctx, input: { id: string }): Promise<SalesReceiptDetail> {
  requirePermission(ctx.actor, "post", "bookkeeper", "post sales receipts");
  const { id: receiptId } = IdSchema.parse(input);
  const r = await loadReceipt(ctx, receiptId);
  if (r.status !== "draft") throw invalidState(`Only draft sales receipts can be posted (this one is ${r.status}).`);
  requirePostingWithinLimit(ctx.actor, money(r.totalAmount).times(money(r.exchangeRate)), `Sales receipt ${r.receiptNumber}`);
  const lines = await ctx.tx.select().from(salesReceiptLines).where(eq(salesReceiptLines.receiptId, r.id)).orderBy(asc(salesReceiptLines.lineNumber));
  const { journalId } = await postSalesDocument(ctx, {
    direction: "sale",
    ref: { salesReceiptId: r.id },
    number: r.receiptNumber,
    label: `Sales receipt ${r.receiptNumber}`,
    date: r.receiptDate,
    currency: r.currency,
    exchangeRate: r.exchangeRate,
    total: r.totalAmount,
    customerId: r.customerId,
    counter: {
      accountId: r.depositAccountId,
      bank: true,
      memo: `Sales receipt ${r.receiptNumber} · ${r.method}${r.reference ? ` ref ${r.reference}` : ""}`,
    },
    lines,
    sourceCode: "CR",
    source: "cash_receipt",
    auditEvent: "ar.sales_receipt.posted",
    entityType: "sales_receipt",
    entityId: r.id,
  });
  await ctx.tx
    .update(salesReceipts)
    .set({ status: "posted", postedAt: sql`now()`, postedBy: ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(salesReceipts.id, r.id));
  return getSalesReceipt(ctx, { id: r.id });
}

export async function voidSalesReceipt(ctx: Ctx, input: z.input<typeof VoidSchema>): Promise<SalesReceiptDetail> {
  requirePermission(ctx.actor, "post", "admin", "void sales receipts");
  const { id: receiptId, reason } = VoidSchema.parse(input);
  const r = await loadReceipt(ctx, receiptId);
  if (r.status !== "posted") throw invalidState(`Only posted sales receipts can be voided (this one is ${r.status}).`);
  const detail = await getSalesReceipt(ctx, { id: r.id });
  if (detail.depositedOn) {
    throw invalidState(`Sales receipt ${r.receiptNumber} is on deposit ${detail.depositedOn.txnNumber}. Void that deposit first.`);
  }
  const { journalId } = await reverseSalesDocument(ctx, {
    glJournalId: r.glJournalId,
    label: `sales receipt ${r.receiptNumber}`,
    reason,
    auditEvent: "ar.sales_receipt.voided",
    entityType: "sales_receipt",
    entityId: r.id,
    number: r.receiptNumber,
  });
  await ctx.tx
    .update(salesReceipts)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(salesReceipts.id, r.id));
  return getSalesReceipt(ctx, { id: r.id });
}

export async function deleteDraftSalesReceipt(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft sales receipts");
  const { id: receiptId } = IdSchema.parse(input);
  const r = await loadReceipt(ctx, receiptId);
  if (r.status !== "draft") throw invalidState(`Only drafts can be deleted (this one is ${r.status}). Void it instead.`);
  await ctx.tx.delete(salesReceipts).where(eq(salesReceipts.id, r.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.sales_receipt.deleted",
      entityType: "sales_receipt",
      entityId: r.id,
      metadata: { receiptNumber: r.receiptNumber },
    },
    ctx.tx
  );
  return { id: r.id };
}
