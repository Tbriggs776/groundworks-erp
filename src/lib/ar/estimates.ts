import Decimal from "decimal.js";
import { format } from "date-fns";
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  arInvoices,
  customers,
  estimateLines,
  estimates,
  items,
  type Estimate,
  type EstimateLine,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { requireActiveCustomer } from "@/lib/parties/service";
import { type ReviewNotice } from "@/lib/review-policy";
import { amount, currency, id, isoDate, likePattern, optionalText, pagination, toPage, type Page } from "@/lib/schemas";
import { documentTotals, lineAmount, resolveSalesLines, SalesLineSchema, taxCodeField, totalsColumns, type ResolvedLine } from "./documents";
import {
  billedByLine,
  linesOfEstimate,
  liveInvoiceCount,
  loadEstimate,
  remainingOf,
  requireBillable,
} from "./estimate-billing";
import { createInvoice, type InvoiceDetail } from "./invoices";

/**
 * ESTIMATES (quotes). No ledger impact until they're billed.
 *
 * Status: pending → accepted | rejected; closed once fully billed (or by
 * hand). Progress invoicing bills an estimate in parts: the remaining
 * amount, a percent of each line, or a custom amount per line. Each invoice
 * line remembers the estimate line it bills; voiding or deleting that
 * invoice puts the amount back.
 */

const EstimateFields = {
  customerId: id,
  estimateDate: isoDate,
  expirationDate: isoDate.nullable().optional().describe("When the quote stops being good. Optional."),
  currency: currency.optional().describe("Defaults to the customer's currency."),
  exchangeRate: amount.optional(),
  taxCodeId: taxCodeField,
  memo: optionalText(2000).describe("Message shown to the customer."),
  privateNote: optionalText(2000).describe("Internal note, never shown to the customer."),
  lines: z.array(SalesLineSchema).min(1, "An estimate needs at least 1 line."),
};

export const CreateEstimateSchema = z.object(EstimateFields);
export type CreateEstimateInput = z.input<typeof CreateEstimateSchema>;
export const UpdateEstimateSchema = z.object({ id, ...EstimateFields });
export type UpdateEstimateInput = z.input<typeof UpdateEstimateSchema>;

export const ESTIMATE_STATUSES = ["pending", "accepted", "rejected", "closed"] as const;

export const ListEstimatesSchema = z.object({
  status: z.enum(ESTIMATE_STATUSES).optional(),
  customerId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional().describe("Search estimate #, memo, or customer name."),
  ...pagination,
});

export const SetEstimateStatusSchema = z.object({
  id,
  status: z.enum(ESTIMATE_STATUSES).describe("accepted: the customer said yes. rejected: they said no. closed: nothing more to bill. pending: back to open."),
  acceptedBy: optionalText(200).describe("With accepted: who accepted it."),
  acceptedDate: isoDate.optional().describe("With accepted: when. Defaults to today."),
});

export const CreateInvoiceFromEstimateSchema = z
  .object({
    id: id.describe("The estimate to bill."),
    invoiceDate: isoDate,
    dueDate: isoDate.optional().describe("Defaults to invoice date + the customer's terms."),
    mode: z
      .enum(["remaining", "percent", "custom"])
      .default("remaining")
      .describe("remaining: bill everything not billed yet. percent: bill `percent` of each line's estimate amount. custom: bill the `lines` amounts."),
    percent: amount.optional().describe("With mode percent: 0 < percent ≤ 100."),
    lines: z
      .array(z.object({ estimateLineId: id, amount }))
      .optional()
      .describe("With mode custom: amount to bill per estimate line. Lines left out bill nothing."),
    poNumber: optionalText(100),
    memo: optionalText(2000).describe("Defaults to the estimate's message."),
    privateNote: optionalText(2000),
    post: z.boolean().optional().describe("Post the invoice in the same call. Without this it stays a draft."),
  })
  .refine((d) => d.mode !== "percent" || (d.percent && money(d.percent).gt(0) && money(d.percent).lte(100)), {
    message: "percent must be more than 0 and at most 100.",
  })
  .refine((d) => d.mode !== "custom" || (d.lines && d.lines.length > 0), { message: "mode custom needs lines." });
export type CreateInvoiceFromEstimateInput = z.input<typeof CreateInvoiceFromEstimateSchema>;

const IdSchema = z.object({ id });

export type EstimateRow = Estimate & { customerName: string; billedAmount: string; invoiceCount: number };
export type EstimateLineRow = EstimateLine & { itemName: string | null; billed: string; remaining: string };
export type EstimateDetail = EstimateRow & {
  lines: EstimateLineRow[];
  remainingAmount: string;
  invoices: Array<{ id: string; invoiceNumber: string; invoiceDate: string; status: string; subtotalAmount: string; totalAmount: string }>;
};

/** Σ of live invoice lines that bill this estimate (pre-tax). */
const billedSql = sql<string>`(SELECT COALESCE(SUM(il.amount), 0) FROM ar_invoice_lines il
  JOIN ar_invoices i ON i.id = il.invoice_id
  WHERE i.estimate_id = "estimates"."id" AND i.status <> 'voided' AND i.deleted_at IS NULL
    AND il.estimate_line_id IS NOT NULL)::text`;
const invoiceCountSql = sql<number>`(SELECT count(*) FROM ar_invoices i
  WHERE i.estimate_id = "estimates"."id" AND i.status <> 'voided' AND i.deleted_at IS NULL)::int`;

export async function listEstimates(ctx: Ctx, input: z.input<typeof ListEstimatesSchema>): Promise<Page<EstimateRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list estimates");
  const f = ListEstimatesSchema.parse(input);
  const rows = await ctx.tx
    .select({ e: estimates, customerName: customers.name, billedAmount: billedSql, invoiceCount: invoiceCountSql })
    .from(estimates)
    .innerJoin(customers, eq(customers.id, estimates.customerId))
    .where(
      and(
        eq(estimates.organizationId, ctx.actor.organizationId),
        isNull(estimates.deletedAt),
        f.status ? eq(estimates.status, f.status) : undefined,
        f.customerId ? eq(estimates.customerId, f.customerId) : undefined,
        f.from ? gte(estimates.estimateDate, f.from) : undefined,
        f.to ? lte(estimates.estimateDate, f.to) : undefined,
        f.q
          ? or(ilike(estimates.estimateNumber, likePattern(f.q)), ilike(estimates.memo, likePattern(f.q)), ilike(customers.name, likePattern(f.q)))
          : undefined
      )
    )
    .orderBy(desc(estimates.estimateDate), desc(estimates.estimateNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.e, customerName: r.customerName, billedAmount: r.billedAmount, invoiceCount: r.invoiceCount })),
    f.limit,
    f.offset
  );
}

export async function getEstimate(ctx: Ctx, input: { id: string }): Promise<EstimateDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view estimates");
  const { id: estimateId } = IdSchema.parse(input);
  const e = await loadEstimate(ctx, estimateId);
  const [c] = await ctx.tx.select({ name: customers.name }).from(customers).where(eq(customers.id, e.customerId));
  const lines = await ctx.tx
    .select({ line: estimateLines, itemName: items.name })
    .from(estimateLines)
    .leftJoin(items, eq(items.id, estimateLines.itemId))
    .where(eq(estimateLines.estimateId, e.id))
    .orderBy(asc(estimateLines.lineNumber));
  const billed = await billedByLine(ctx, e.id);
  const invoices = await ctx.tx
    .select({
      id: arInvoices.id,
      invoiceNumber: arInvoices.invoiceNumber,
      invoiceDate: arInvoices.invoiceDate,
      status: arInvoices.status,
      subtotalAmount: arInvoices.subtotalAmount,
      totalAmount: arInvoices.totalAmount,
    })
    .from(arInvoices)
    .where(and(eq(arInvoices.organizationId, ctx.actor.organizationId), eq(arInvoices.estimateId, e.id), isNull(arInvoices.deletedAt)))
    .orderBy(asc(arInvoices.invoiceDate), asc(arInvoices.invoiceNumber));
  const lineRows = lines.map((l) => ({
    ...l.line,
    itemName: l.itemName,
    billed: toDbMoney(billed.get(l.line.id) ?? 0),
    remaining: toDbMoney(remainingOf(l.line, billed.get(l.line.id))),
  }));
  const billedTotal = sumMoney(lineRows.map((l) => l.billed));
  return {
    ...e,
    customerName: c?.name ?? "",
    billedAmount: toDbMoney(billedTotal),
    remainingAmount: toDbMoney(money(e.subtotalAmount).minus(billedTotal)),
    invoiceCount: invoices.filter((i) => i.status !== "voided").length,
    lines: lineRows,
    invoices,
  };
}

async function resolveEstimate(ctx: Ctx, d: z.output<typeof CreateEstimateSchema>) {
  const customer = await requireActiveCustomer(ctx, d.customerId);
  const lines = await resolveSalesLines(ctx, d.lines);
  const totals = await documentTotals(ctx, { customer, taxCodeId: d.taxCodeId, lines });
  if (d.expirationDate && d.expirationDate < d.estimateDate) {
    throw new AppError("invalid_input", "The expiration date can't be before the estimate date.");
  }
  return {
    header: {
      customerId: customer.id,
      estimateDate: d.estimateDate,
      expirationDate: d.expirationDate ?? null,
      currency: d.currency ?? customer.currency,
      exchangeRate: d.exchangeRate ?? "1",
      ...totalsColumns(totals),
      memo: d.memo,
      privateNote: d.privateNote,
    },
    lines,
  };
}

async function insertLines(ctx: Ctx, estimateId: string, lines: ResolvedLine[]) {
  await ctx.tx
    .insert(estimateLines)
    .values(lines.map((l, i) => ({ organizationId: ctx.actor.organizationId, estimateId, lineNumber: i + 1, ...l })));
}

export async function createEstimate(ctx: Ctx, input: CreateEstimateInput): Promise<EstimateDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create estimates");
  const d = CreateEstimateSchema.parse(input);
  const org = ctx.actor.organizationId;
  const { header, lines } = await resolveEstimate(ctx, d);
  const estimateNumber = await nextNumber(ctx.tx, org, "EST");
  const [e] = await ctx.tx
    .insert(estimates)
    .values({ organizationId: org, estimateNumber, ...header, status: "pending", ...creatorFields(ctx.actor) })
    .returning();
  await insertLines(ctx, e.id, lines);
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ar.estimate.created",
      entityType: "estimate",
      entityId: e.id,
      metadata: { estimateNumber, customerId: e.customerId, total: e.totalAmount },
    },
    ctx.tx
  );
  return getEstimate(ctx, { id: e.id });
}

export async function updateEstimate(ctx: Ctx, input: UpdateEstimateInput): Promise<EstimateDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit estimates");
  const d = UpdateEstimateSchema.parse(input);
  const e = await loadEstimate(ctx, d.id, true);
  if (e.status === "closed") throw invalidState(`Estimate ${e.estimateNumber} is closed. Reopen it to edit.`);
  if ((await liveInvoiceCount(ctx, e.id)) > 0) {
    throw invalidState(`Estimate ${e.estimateNumber} has been invoiced, so its lines are fixed. Void or delete those invoices first, or make a new estimate.`);
  }
  const { header, lines } = await resolveEstimate(ctx, d);
  await ctx.tx.update(estimates).set({ ...header, updatedAt: sql`now()` }).where(eq(estimates.id, e.id));
  await ctx.tx.delete(estimateLines).where(eq(estimateLines.estimateId, e.id));
  await insertLines(ctx, e.id, lines);
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.estimate.updated",
      entityType: "estimate",
      entityId: e.id,
      metadata: { estimateNumber: e.estimateNumber, total: header.totalAmount },
    },
    ctx.tx
  );
  return getEstimate(ctx, { id: e.id });
}

export async function setEstimateStatus(ctx: Ctx, input: z.input<typeof SetEstimateStatusSchema>): Promise<EstimateDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "change estimate status");
  const d = SetEstimateStatusSchema.parse(input);
  const e = await loadEstimate(ctx, d.id, true);
  if (d.status === "rejected" && (await liveInvoiceCount(ctx, e.id)) > 0) {
    throw invalidState(`Estimate ${e.estimateNumber} has invoices. Close it instead of rejecting it.`);
  }
  if (d.status !== "closed" && d.status !== "rejected" && e.status === "closed") {
    const billed = await billedByLine(ctx, e.id);
    const lines = await linesOfEstimate(ctx, e.id);
    if (lines.every((l) => remainingOf(l, billed.get(l.id)).isZero())) {
      throw invalidState(`Estimate ${e.estimateNumber} is fully billed; there's nothing to reopen.`);
    }
  }
  const accepted =
    d.status === "accepted"
      ? { acceptedBy: d.acceptedBy ?? e.acceptedBy, acceptedDate: d.acceptedDate ?? e.acceptedDate ?? format(new Date(), "yyyy-MM-dd") }
      : d.status === "pending"
        ? { acceptedBy: null, acceptedDate: null }
        : {};
  await ctx.tx
    .update(estimates)
    .set({ status: d.status, ...accepted, updatedAt: sql`now()` })
    .where(eq(estimates.id, e.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: `ar.estimate.${d.status === "pending" ? "reopened" : d.status}`,
      entityType: "estimate",
      entityId: e.id,
      metadata: { estimateNumber: e.estimateNumber, from: e.status, to: d.status, ...accepted },
    },
    ctx.tx
  );
  return getEstimate(ctx, { id: e.id });
}

export async function deleteEstimate(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete estimates");
  const { id: estimateId } = IdSchema.parse(input);
  const e = await loadEstimate(ctx, estimateId, true);
  if ((await liveInvoiceCount(ctx, e.id)) > 0) {
    throw invalidState(`Estimate ${e.estimateNumber} has invoices. Void or delete them first, or close the estimate.`);
  }
  await ctx.tx.delete(estimates).where(eq(estimates.id, e.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.estimate.deleted",
      entityType: "estimate",
      entityId: e.id,
      metadata: { estimateNumber: e.estimateNumber, total: e.totalAmount },
    },
    ctx.tx
  );
  return { id: e.id };
}

/**
 * One invoice line billing `amt` of an estimate line. The whole line keeps
 * its quantity and rate; a part keeps the rate and bills a fraction of the
 * quantity, or 1 × the amount when the rate can't express it to the cent.
 */
function billingLine(el: EstimateLine, amt: Decimal) {
  const base = {
    itemId: el.itemId ?? undefined,
    accountId: el.accountId,
    description: el.description ?? undefined,
    taxable: el.taxable,
    dimensions: el.dimensions,
    estimateLineId: el.id,
  };
  if (amt.eq(money(el.amount))) return { ...base, quantity: el.quantity, unitPrice: el.unitPrice };
  const rate = money(el.unitPrice);
  if (!rate.isZero()) {
    const qty = amt.div(rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    if (qty.gt(0) && money(lineAmount(qty.toString(), el.unitPrice)).eq(amt)) {
      return { ...base, quantity: qty.toFixed(4), unitPrice: el.unitPrice };
    }
  }
  return { ...base, quantity: "1", unitPrice: toDbMoney(amt) };
}

export async function createInvoiceFromEstimate(
  ctx: Ctx,
  input: CreateInvoiceFromEstimateInput
): Promise<InvoiceDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create invoices");
  const d = CreateInvoiceFromEstimateSchema.parse(input);
  const e = await loadEstimate(ctx, d.id, true);
  requireBillable(e);
  const lines = await linesOfEstimate(ctx, e.id);
  const billed = await billedByLine(ctx, e.id);
  const custom = new Map((d.lines ?? []).map((l) => [l.estimateLineId, money(l.amount)]));
  for (const lineId of custom.keys()) {
    if (!lines.some((l) => l.id === lineId)) throw new AppError("invalid_input", `That estimate line isn't on ${e.estimateNumber}.`);
  }

  const invoiceLines = lines
    .map((el) => {
      const left = remainingOf(el, billed.get(el.id));
      let amt: Decimal;
      if (d.mode === "remaining") amt = left;
      else if (d.mode === "custom") amt = custom.get(el.id) ?? money(0);
      else {
        amt = money(el.amount).times(money(d.percent!)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        // Never past what's left: the last percent bills the rounding remainder.
        if (money(el.amount).isNegative() ? amt.lt(left) : amt.gt(left)) amt = left;
      }
      return { el, amt };
    })
    .filter((x) => !x.amt.isZero());
  if (invoiceLines.length === 0) throw invalidState(`Nothing to bill on estimate ${e.estimateNumber}.`);

  const invoice = await createInvoice(
    ctx,
    {
      customerId: e.customerId,
      invoiceDate: d.invoiceDate,
      dueDate: d.dueDate,
      poNumber: d.poNumber,
      currency: e.currency,
      // Stored with 10 places; the rate itself came in with at most 4.
      exchangeRate: money(e.exchangeRate).toString(),
      taxCodeId: e.taxCodeId,
      memo: d.memo ?? e.memo ?? undefined,
      privateNote: d.privateNote,
      lines: invoiceLines.map(({ el, amt }) => billingLine(el, amt)),
      post: d.post,
    },
    { estimateId: e.id }
  );
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.estimate.invoiced",
      entityType: "estimate",
      entityId: e.id,
      metadata: { estimateNumber: e.estimateNumber, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, mode: d.mode, subtotal: invoice.subtotalAmount },
    },
    ctx.tx
  );
  return invoice;
}
