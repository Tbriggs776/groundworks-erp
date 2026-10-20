import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  creditMemoLines,
  creditMemos,
  customers,
  items,
  type CreditMemo,
  type CreditMemoLine,
  type SalesTaxLine,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { invalidState, notFound } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { controlAccount } from "@/lib/gl/lookups";
import { money } from "@/lib/money";
import { requireActiveCustomer } from "@/lib/parties/service";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import { amount, currency, id, isoDate, likePattern, optionalText, pagination, toPage, type Page } from "@/lib/schemas";
import { creditMemoLeftSql } from "./balances";
import { autoApplyCreditMemo, releaseCreditApplications, usesOfCredit } from "./credits";
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
 * CREDIT MEMOS: what the business owes a customer back (returned goods, a
 * pricing correction, goodwill). Lifecycle draft → open → applied | voided.
 * Posting: Dr income, Dr sales tax / Cr AR. Its credit then pays down open
 * invoices (automatically, oldest first, when the company's setting is
 * on) or is paid out with a credit refund.
 */

export const CreateCreditMemoSchema = z.object({
  customerId: id,
  memoDate: isoDate.describe("Credit date; also the posting date."),
  currency: currency.optional(),
  exchangeRate: amount.optional(),
  taxCodeId: taxCodeField,
  memo: optionalText(2000).describe("Message shown to the customer."),
  privateNote: optionalText(2000),
  lines: z.array(SalesLineSchema).min(1, "A credit memo needs at least 1 line."),
  post: z.boolean().optional().describe("Post in the same call (and apply the credit if the company auto-applies)."),
});
export type CreateCreditMemoInput = z.input<typeof CreateCreditMemoSchema>;

export const ListCreditMemosSchema = z.object({
  status: z.enum(["draft", "open", "applied", "voided"]).optional(),
  customerId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional(),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type CreditMemoRow = CreditMemo & { customerName: string; remaining: string };
export type CreditMemoDetail = CreditMemoRow & {
  lines: Array<CreditMemoLine & { itemName: string | null }>;
  taxLines: Array<SalesTaxLine & { agencyName: string }>;
  uses: Awaited<ReturnType<typeof usesOfCredit>>;
};

const remaining = sql<string>`(CASE WHEN ${creditMemos.status} IN ('open', 'applied')
  THEN ${creditMemoLeftSql(sql`"credit_memos"."id"`, sql`"credit_memos"."total_amount"`)} ELSE 0 END)::text`;

export async function listCreditMemos(ctx: Ctx, input: z.input<typeof ListCreditMemosSchema>): Promise<Page<CreditMemoRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list credit memos");
  const f = ListCreditMemosSchema.parse(input);
  const rows = await ctx.tx
    .select({ m: creditMemos, customerName: customers.name, remaining })
    .from(creditMemos)
    .innerJoin(customers, eq(customers.id, creditMemos.customerId))
    .where(
      and(
        eq(creditMemos.organizationId, ctx.actor.organizationId),
        isNull(creditMemos.deletedAt),
        f.status ? eq(creditMemos.status, f.status) : undefined,
        f.customerId ? eq(creditMemos.customerId, f.customerId) : undefined,
        f.from ? gte(creditMemos.memoDate, f.from) : undefined,
        f.to ? lte(creditMemos.memoDate, f.to) : undefined,
        f.q ? or(ilike(creditMemos.memoNumber, likePattern(f.q)), ilike(creditMemos.memo, likePattern(f.q)), ilike(customers.name, likePattern(f.q))) : undefined
      )
    )
    .orderBy(desc(creditMemos.memoDate), desc(creditMemos.memoNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map((x) => ({ ...x.m, customerName: x.customerName, remaining: x.remaining })), f.limit, f.offset);
}

export async function getCreditMemo(ctx: Ctx, input: { id: string }): Promise<CreditMemoDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view credit memos");
  const { id: memoId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select({ m: creditMemos, customerName: customers.name, remaining })
    .from(creditMemos)
    .innerJoin(customers, eq(customers.id, creditMemos.customerId))
    .where(and(eq(creditMemos.id, memoId), eq(creditMemos.organizationId, ctx.actor.organizationId), isNull(creditMemos.deletedAt)));
  if (!row) throw notFound("Credit memo");
  const lines = await ctx.tx
    .select({ line: creditMemoLines, itemName: items.name })
    .from(creditMemoLines)
    .leftJoin(items, eq(items.id, creditMemoLines.itemId))
    .where(eq(creditMemoLines.creditMemoId, memoId))
    .orderBy(asc(creditMemoLines.lineNumber));
  return {
    ...row.m,
    customerName: row.customerName,
    remaining: row.remaining,
    lines: lines.map((l) => ({ ...l.line, itemName: l.itemName })),
    taxLines: await withAgencyNames(ctx, await taxLinesOf(ctx, { creditMemoId: memoId })),
    uses: await usesOfCredit(ctx, { creditMemoId: memoId }),
  };
}

async function loadMemo(ctx: Ctx, memoId: string): Promise<CreditMemo> {
  const [m] = await ctx.tx
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.id, memoId), eq(creditMemos.organizationId, ctx.actor.organizationId), isNull(creditMemos.deletedAt)))
    .for("update");
  if (!m) throw notFound("Credit memo");
  return m;
}

async function insertLines(ctx: Ctx, creditMemoId: string, lines: ResolvedLine[]) {
  await ctx.tx
    .insert(creditMemoLines)
    .values(lines.map((l, i) => ({ organizationId: ctx.actor.organizationId, creditMemoId, lineNumber: i + 1, ...l })));
}

export async function createCreditMemo(ctx: Ctx, input: CreateCreditMemoInput): Promise<CreditMemoDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create credit memos");
  const d = CreateCreditMemoSchema.parse(input);
  const org = ctx.actor.organizationId;
  const customer = await requireActiveCustomer(ctx, d.customerId);
  const lines = await resolveSalesLines(ctx, d.lines);
  const totals = await documentTotals(ctx, { customer, taxCodeId: d.taxCodeId, lines });
  const memoNumber = await nextNumber(ctx.tx, org, "CM");
  const [m] = await ctx.tx
    .insert(creditMemos)
    .values({
      organizationId: org,
      memoNumber,
      customerId: customer.id,
      memoDate: d.memoDate,
      currency: d.currency ?? customer.currency,
      exchangeRate: d.exchangeRate ?? "1",
      ...totalsColumns(totals),
      memo: d.memo,
      privateNote: d.privateNote,
      status: "draft",
      ...creatorFields(ctx.actor),
    })
    .returning();
  await insertLines(ctx, m.id, lines);
  await writeTaxLines(ctx, { creditMemoId: m.id }, totals);
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ar.credit_memo.created",
      entityType: "credit_memo",
      entityId: m.id,
      metadata: { memoNumber, customerId: customer.id, total: m.totalAmount, tax: m.taxAmount },
    },
    ctx.tx
  );
  if (d.post) {
    return postOrQueueForReview(ctx, (c) => postCreditMemo(c, { id: m.id }), () => getCreditMemo(ctx, { id: m.id }));
  }
  return getCreditMemo(ctx, { id: m.id });
}

export async function postCreditMemo(ctx: Ctx, input: { id: string }): Promise<CreditMemoDetail> {
  requirePermission(ctx.actor, "post", "bookkeeper", "post credit memos");
  const { id: memoId } = IdSchema.parse(input);
  const m = await loadMemo(ctx, memoId);
  if (m.status !== "draft") throw invalidState(`Only draft credit memos can be posted (this one is ${m.status}).`);
  requirePostingWithinLimit(ctx.actor, money(m.totalAmount).times(money(m.exchangeRate)), `Credit memo ${m.memoNumber}`);
  const ar = await controlAccount(ctx.tx, ctx.actor.organizationId, "receivables");
  const lines = await ctx.tx.select().from(creditMemoLines).where(eq(creditMemoLines.creditMemoId, m.id)).orderBy(asc(creditMemoLines.lineNumber));
  const { journalId } = await postSalesDocument(ctx, {
    direction: "return",
    ref: { creditMemoId: m.id },
    number: m.memoNumber,
    label: `Credit memo ${m.memoNumber}`,
    date: m.memoDate,
    currency: m.currency,
    exchangeRate: m.exchangeRate,
    total: m.totalAmount,
    customerId: m.customerId,
    counter: { accountId: ar.id, bank: false, memo: `Credit memo ${m.memoNumber}` },
    lines,
    sourceCode: "SJ",
    source: "ar",
    auditEvent: "ar.credit_memo.posted",
    entityType: "credit_memo",
    entityId: m.id,
  });
  await ctx.tx
    .update(creditMemos)
    .set({ status: "open", postedAt: sql`now()`, postedBy: ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(creditMemos.id, m.id));
  await autoApplyCreditMemo(ctx, m.id);
  return getCreditMemo(ctx, { id: m.id });
}

export async function voidCreditMemo(ctx: Ctx, input: z.input<typeof VoidSchema>): Promise<CreditMemoDetail> {
  requirePermission(ctx.actor, "post", "admin", "void credit memos");
  const { id: memoId, reason } = VoidSchema.parse(input);
  const m = await loadMemo(ctx, memoId);
  if (m.status !== "open" && m.status !== "applied") {
    throw invalidState(`Only posted credit memos can be voided (this one is ${m.status}).`);
  }
  // Invoices it paid down reopen; a credit already refunded blocks the void.
  await releaseCreditApplications(ctx, { creditMemoId: m.id }, `Credit memo ${m.memoNumber}`);
  const { journalId } = await reverseSalesDocument(ctx, {
    glJournalId: m.glJournalId,
    label: `credit memo ${m.memoNumber}`,
    reason,
    auditEvent: "ar.credit_memo.voided",
    entityType: "credit_memo",
    entityId: m.id,
    number: m.memoNumber,
  });
  await ctx.tx
    .update(creditMemos)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(creditMemos.id, m.id));
  return getCreditMemo(ctx, { id: m.id });
}

export async function deleteDraftCreditMemo(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft credit memos");
  const { id: memoId } = IdSchema.parse(input);
  const m = await loadMemo(ctx, memoId);
  if (m.status !== "draft") throw invalidState(`Only drafts can be deleted (this one is ${m.status}). Void it instead.`);
  await ctx.tx.delete(creditMemos).where(eq(creditMemos.id, m.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.credit_memo.deleted",
      entityType: "credit_memo",
      entityId: m.id,
      metadata: { memoNumber: m.memoNumber },
    },
    ctx.tx
  );
  return { id: m.id };
}
