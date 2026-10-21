import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, vendorCreditLines, vendorCredits, vendors, type VendorCredit, type VendorCreditLine } from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { controlAccount, requireLineAccounts, sourceCodeId } from "@/lib/gl/lookups";
import { createAndPostJournal, reverseJournal, type JournalLineInput } from "@/lib/gl/posting";
import { PurchaseLineItemFields, recordSale, resolvePurchaseLines } from "@/lib/inventory/documents";
import { voidMovements } from "@/lib/inventory/engine";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { requireActiveVendor } from "@/lib/parties/service";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import { amount, currency, id, isoDate, likePattern, optionalText, pagination, positiveAmount, toPage, type Page } from "@/lib/schemas";
import { vendorCreditLeftSql } from "./balances";
import { releaseVendorCreditApplications, usesOfVendorCredit } from "./credits";

/**
 * VENDOR CREDITS: what a vendor owes the business back (returned goods, a
 * rebate, an overcharge). Lifecycle draft → open → applied | voided.
 * Posting: Dr AP / Cr each line's account. The credit pays down the
 * vendor's bills (apply_vendor_credit) or comes back as a vendor refund.
 * Inventory items sent back leave stock (see src/lib/inventory/documents.ts).
 */

const LineSchema = z.object({
  accountId: id
    .optional()
    .nullable()
    .describe("Account to credit: usually the expense or asset the original bill hit. Optional with an item."),
  amount: positiveAmount.optional().nullable().describe("Optional when quantity and unit cost are given."),
  description: optionalText(500),
  itemId: PurchaseLineItemFields.itemId.describe(
    "A product sent back. An inventory item leaves stock at its cost; the line credits the item's cost of goods sold account, so COGS keeps any difference."
  ),
  quantity: PurchaseLineItemFields.quantity.describe("Units sent back. Required for inventory items."),
  unitCost: PurchaseLineItemFields.unitCost,
  lotNumber: PurchaseLineItemFields.lotNumber,
});

export const CreateVendorCreditSchema = z.object({
  vendorId: id,
  creditDate: isoDate.describe("Date on the vendor's credit memo; also the posting date."),
  vendorReference: optionalText(100).describe("The vendor's credit memo number."),
  currency: currency.optional().describe("Defaults to the vendor's currency."),
  exchangeRate: amount.optional(),
  memo: optionalText(1000),
  lines: z.array(LineSchema).min(1, "A vendor credit needs at least 1 line."),
  post: z.boolean().optional().describe("Post in the same call."),
});
export type CreateVendorCreditInput = z.input<typeof CreateVendorCreditSchema>;

export const ListVendorCreditsSchema = z.object({
  status: z.enum(["draft", "open", "applied", "voided"]).optional(),
  vendorId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional(),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type VendorCreditRow = VendorCredit & { vendorName: string; remaining: string };
export type VendorCreditDetail = VendorCreditRow & {
  lines: Array<VendorCreditLine & { accountCode: string; accountName: string }>;
  uses: Awaited<ReturnType<typeof usesOfVendorCredit>>;
};

const remaining = sql<string>`(CASE WHEN ${vendorCredits.status} IN ('open', 'applied')
  THEN ${vendorCreditLeftSql(sql`"vendor_credits"."id"`, sql`"vendor_credits"."total_amount"`)} ELSE 0 END)::text`;

export async function listVendorCredits(ctx: Ctx, input: z.input<typeof ListVendorCreditsSchema>): Promise<Page<VendorCreditRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list vendor credits");
  const f = ListVendorCreditsSchema.parse(input);
  const rows = await ctx.tx
    .select({ c: vendorCredits, vendorName: vendors.name, remaining })
    .from(vendorCredits)
    .innerJoin(vendors, eq(vendors.id, vendorCredits.vendorId))
    .where(
      and(
        eq(vendorCredits.organizationId, ctx.actor.organizationId),
        isNull(vendorCredits.deletedAt),
        f.status ? eq(vendorCredits.status, f.status) : undefined,
        f.vendorId ? eq(vendorCredits.vendorId, f.vendorId) : undefined,
        f.from ? gte(vendorCredits.creditDate, f.from) : undefined,
        f.to ? lte(vendorCredits.creditDate, f.to) : undefined,
        f.q
          ? or(
              ilike(vendorCredits.creditNumber, likePattern(f.q)),
              ilike(vendorCredits.vendorReference, likePattern(f.q)),
              ilike(vendorCredits.memo, likePattern(f.q)),
              ilike(vendors.name, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(desc(vendorCredits.creditDate), desc(vendorCredits.creditNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map((r) => ({ ...r.c, vendorName: r.vendorName, remaining: r.remaining })), f.limit, f.offset);
}

export async function getVendorCredit(ctx: Ctx, input: { id: string }): Promise<VendorCreditDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view vendor credits");
  const { id: creditId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select({ c: vendorCredits, vendorName: vendors.name, remaining })
    .from(vendorCredits)
    .innerJoin(vendors, eq(vendors.id, vendorCredits.vendorId))
    .where(and(eq(vendorCredits.id, creditId), eq(vendorCredits.organizationId, ctx.actor.organizationId), isNull(vendorCredits.deletedAt)));
  if (!row) throw notFound("Vendor credit");
  const lines = await ctx.tx
    .select({ l: vendorCreditLines, accountCode: accounts.code, accountName: accounts.name })
    .from(vendorCreditLines)
    .innerJoin(accounts, eq(accounts.id, vendorCreditLines.accountId))
    .where(eq(vendorCreditLines.vendorCreditId, creditId))
    .orderBy(asc(vendorCreditLines.lineNumber));
  return {
    ...row.c,
    vendorName: row.vendorName,
    remaining: row.remaining,
    lines: lines.map((x) => ({ ...x.l, accountCode: x.accountCode, accountName: x.accountName })),
    uses: await usesOfVendorCredit(ctx, { vendorCreditId: creditId }),
  };
}

async function loadCredit(ctx: Ctx, creditId: string): Promise<VendorCredit> {
  const [c] = await ctx.tx
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, creditId), eq(vendorCredits.organizationId, ctx.actor.organizationId), isNull(vendorCredits.deletedAt)))
    .for("update");
  if (!c) throw notFound("Vendor credit");
  return c;
}

export async function createVendorCredit(ctx: Ctx, input: CreateVendorCreditInput): Promise<VendorCreditDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create vendor credits");
  const d = CreateVendorCreditSchema.parse(input);
  const org = ctx.actor.organizationId;
  const vendor = await requireActiveVendor(ctx, d.vendorId);
  const lines = await resolvePurchaseLines(ctx, d.lines, { allowInventory: true, returning: true });
  await requireLineAccounts(ctx.tx, org, lines.map((l) => l.accountId));
  const total = sumMoney(lines.map((l) => l.amount));
  const creditNumber = await nextNumber(ctx.tx, org, "VC");
  const [c] = await ctx.tx
    .insert(vendorCredits)
    .values({
      organizationId: org,
      creditNumber,
      vendorId: vendor.id,
      creditDate: d.creditDate,
      vendorReference: d.vendorReference,
      currency: d.currency ?? vendor.currency,
      exchangeRate: d.exchangeRate ?? "1",
      totalAmount: toDbMoney(total),
      memo: d.memo,
      status: "draft",
      ...creatorFields(ctx.actor),
    })
    .returning();
  await ctx.tx
    .insert(vendorCreditLines)
    .values(
      lines.map((l, i) => ({
        organizationId: org,
        vendorCreditId: c.id,
        lineNumber: i + 1,
        accountId: l.accountId,
        amount: l.amount,
        description: l.description,
        itemId: l.itemId,
        quantity: l.quantity,
        unitCost: l.unitCost,
        lotNumber: l.lotNumber,
      }))
    );
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.vendor_credit.created",
      entityType: "vendor_credit",
      entityId: c.id,
      metadata: { creditNumber, vendorId: vendor.id, total: c.totalAmount },
    },
    ctx.tx
  );
  if (d.post) {
    return postOrQueueForReview(ctx, (cx) => postVendorCredit(cx, { id: c.id }), () => getVendorCredit(ctx, { id: c.id }));
  }
  return getVendorCredit(ctx, { id: c.id });
}

export async function postVendorCredit(ctx: Ctx, input: { id: string }): Promise<VendorCreditDetail> {
  requirePermission(ctx.actor, "post", "accountant", "post vendor credits");
  const { id: creditId } = IdSchema.parse(input);
  const c = await loadCredit(ctx, creditId);
  if (c.status !== "draft") throw invalidState(`Only draft vendor credits can be posted (this one is ${c.status}).`);
  requirePostingWithinLimit(ctx.actor, money(c.totalAmount).times(money(c.exchangeRate)), `Vendor credit ${c.creditNumber}`);
  const org = ctx.actor.organizationId;
  const ap = await controlAccount(ctx.tx, org, "payables");
  const lines = await ctx.tx.select().from(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, c.id)).orderBy(asc(vendorCreditLines.lineNumber));
  const label = `Vendor credit ${c.creditNumber}`;
  const jeLines: JournalLineInput[] = [
    { accountId: ap.id, debit: c.totalAmount, memo: `${label}${c.vendorReference ? ` · ${c.vendorReference}` : ""}`, vendorId: c.vendorId },
    ...lines.map((l) => ({ accountId: l.accountId, credit: l.amount, memo: l.description ?? label, vendorId: c.vendorId })),
  ];
  const result = await createAndPostJournal(
    {
      organizationId: org,
      actorId: ctx.actor.userId,
      actor: ctx.actor,
      journalDate: c.creditDate,
      sourceCodeId: await sourceCodeId(ctx.tx, org, "PJ"),
      source: "ap",
      description: label,
      currency: c.currency,
      exchangeRate: c.exchangeRate,
      documentNo: c.vendorReference ?? c.creditNumber,
      lines: jeLines,
    },
    ctx.tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  await recordSale(ctx, { direction: "vendor_return", sourceType: "vendor_credit", sourceId: c.id, label, date: c.creditDate, lines });
  await ctx.tx
    .update(vendorCredits)
    .set({ status: "open", postedAt: sql`now()`, postedBy: ctx.actor.userId, glJournalId: result.journalId, updatedAt: sql`now()` })
    .where(eq(vendorCredits.id, c.id));
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.vendor_credit.posted",
      entityType: "vendor_credit",
      entityId: c.id,
      metadata: { creditNumber: c.creditNumber, journalId: result.journalId, total: c.totalAmount },
    },
    ctx.tx
  );
  return getVendorCredit(ctx, { id: c.id });
}

export async function voidVendorCredit(ctx: Ctx, input: z.input<typeof VoidSchema>): Promise<VendorCreditDetail> {
  requirePermission(ctx.actor, "post", "admin", "void vendor credits");
  const { id: creditId, reason } = VoidSchema.parse(input);
  const c = await loadCredit(ctx, creditId);
  if (c.status !== "open" && c.status !== "applied") throw invalidState(`Only posted vendor credits can be voided (this one is ${c.status}).`);
  if (!c.glJournalId) throw invalidState(`Vendor credit ${c.creditNumber} has no posted journal to reverse.`);
  // Bills it paid down reopen; a credit already refunded blocks the void.
  await releaseVendorCreditApplications(ctx, { vendorCreditId: c.id }, `Vendor credit ${c.creditNumber}`);
  const result = await reverseJournal(
    c.glJournalId,
    { actorId: ctx.actor.userId, actor: ctx.actor, organizationId: ctx.actor.organizationId, description: `Void of vendor credit ${c.creditNumber}: ${reason}` },
    ctx.tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  await voidMovements(ctx, "vendor_credit", c.id);
  await ctx.tx
    .update(vendorCredits)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId: result.journalId, updatedAt: sql`now()` })
    .where(eq(vendorCredits.id, c.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.vendor_credit.voided",
      entityType: "vendor_credit",
      entityId: c.id,
      metadata: { creditNumber: c.creditNumber, reason, reversalJournalId: result.journalId },
    },
    ctx.tx
  );
  return getVendorCredit(ctx, { id: c.id });
}

export async function deleteDraftVendorCredit(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft vendor credits");
  const { id: creditId } = IdSchema.parse(input);
  const c = await loadCredit(ctx, creditId);
  if (c.status !== "draft") throw invalidState(`Only drafts can be deleted (this one is ${c.status}). Void it instead.`);
  await ctx.tx.delete(vendorCredits).where(eq(vendorCredits.id, c.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.vendor_credit.deleted",
      entityType: "vendor_credit",
      entityId: c.id,
      metadata: { creditNumber: c.creditNumber },
    },
    ctx.tx
  );
  return { id: c.id };
}
