import { addDays, format, parseISO } from "date-fns";
import { and, asc, desc, eq, gte, ilike, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  arInvoiceLines,
  arInvoices,
  arPaymentApplications,
  arPayments,
  customers,
  items,
  taxAgencies,
  type ArInvoice,
  type ArInvoiceLine,
  type SalesTaxLine,
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
import { money } from "@/lib/money";
import { requireActiveCustomer } from "@/lib/parties/service";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
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
  toPage,
} from "@/lib/schemas";
import { invoiceSettledSql } from "./balances";
import { autoApplyCreditsToInvoice, creditsOnInvoice } from "./credits";
import {
  documentTotals,
  resolveSalesLines,
  SalesLineSchema,
  taxCodeField,
  taxLinesOf,
  totalsColumns,
  writeTaxLines,
} from "./documents";
import { invoiceAppliedTotal, postInvoiceToGl, voidInvoiceFromGl } from "./posting";

/**
 * INVOICES (AR). Lifecycle: draft → open → paid | voided.
 *
 * A line can be as small as { itemId } (price, description, income
 * account, and taxable come from the item) or fully explicit
 * { description, quantity, unitPrice, accountId }. A negative unit price
 * makes a discount line. Sales tax is charged on the taxable total.
 */

const InvoiceFields = {
  customerId: id,
  invoiceDate: isoDate.describe("Invoice date; also the posting date."),
  dueDate: isoDate.optional().describe("Defaults to invoice date + the customer's terms."),
  poNumber: optionalText(100).describe("Customer's PO / reference."),
  currency: currency.optional().describe("Defaults to the customer's currency."),
  exchangeRate: amount.optional(),
  memo: optionalText(2000).describe("Message shown to the customer."),
  privateNote: optionalText(2000).describe("Internal note, never shown to the customer."),
  taxCodeId: taxCodeField,
  lines: z.array(SalesLineSchema).min(1, "An invoice needs at least 1 line."),
};

export const CreateInvoiceSchema = z.object({
  ...InvoiceFields,
  post: z
    .boolean()
    .optional()
    .describe("Post (finalize) immediately. Without this the invoice stays a draft for review."),
});
export type CreateInvoiceInput = z.input<typeof CreateInvoiceSchema>;

export const UpdateInvoiceSchema = z.object({ id, ...InvoiceFields });
export type UpdateInvoiceInput = z.input<typeof UpdateInvoiceSchema>;

export const ListInvoicesSchema = z.object({
  status: z.enum(["draft", "open", "paid", "voided"]).optional(),
  customerId: id.optional(),
  overdueOnly: flag.optional().describe("Open invoices past their due date."),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().optional().describe("Search invoice #, PO #, memo, or customer name."),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type InvoiceRow = ArInvoice & { customerName: string; openBalance: string };
export type InvoiceDetail = InvoiceRow & {
  lines: Array<ArInvoiceLine & { itemName: string | null }>;
  taxLines: Array<SalesTaxLine & { agencyName: string }>;
  payments: Array<{ paymentId: string; paymentNumber: string; paymentDate: string; amount: string; discountAmount: string; status: string }>;
  credits: Awaited<ReturnType<typeof creditsOnInvoice>>;
};

const openBalance = sql<string>`(CASE WHEN ${arInvoices.status} IN ('open', 'paid')
  THEN ${arInvoices.totalAmount} - ${invoiceSettledSql(sql`"ar_invoices"."id"`)}
  ELSE 0 END)::text`;

export async function listInvoices(
  ctx: Ctx,
  input: z.input<typeof ListInvoicesSchema>
): Promise<Page<InvoiceRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list invoices");
  const f = ListInvoicesSchema.parse(input);
  const today = format(new Date(), "yyyy-MM-dd");
  const rows = await ctx.tx
    .select({ invoice: arInvoices, customerName: customers.name, openBalance })
    .from(arInvoices)
    .innerJoin(customers, eq(customers.id, arInvoices.customerId))
    .where(
      and(
        eq(arInvoices.organizationId, ctx.actor.organizationId),
        isNull(arInvoices.deletedAt),
        f.status ? eq(arInvoices.status, f.status) : undefined,
        f.customerId ? eq(arInvoices.customerId, f.customerId) : undefined,
        f.overdueOnly
          ? and(eq(arInvoices.status, "open"), lt(arInvoices.dueDate, today))
          : undefined,
        f.from ? gte(arInvoices.invoiceDate, f.from) : undefined,
        f.to ? lte(arInvoices.invoiceDate, f.to) : undefined,
        f.q
          ? or(
              ilike(arInvoices.invoiceNumber, likePattern(f.q)),
              ilike(arInvoices.poNumber, likePattern(f.q)),
              ilike(arInvoices.memo, likePattern(f.q)),
              ilike(customers.name, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(desc(arInvoices.invoiceDate), desc(arInvoices.invoiceNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.invoice, customerName: r.customerName, openBalance: r.openBalance })),
    f.limit,
    f.offset
  );
}

export async function getInvoice(ctx: Ctx, input: { id: string }): Promise<InvoiceDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view invoices");
  const { id: invoiceId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select({ invoice: arInvoices, customerName: customers.name, openBalance })
    .from(arInvoices)
    .innerJoin(customers, eq(customers.id, arInvoices.customerId))
    .where(
      and(
        eq(arInvoices.id, invoiceId),
        eq(arInvoices.organizationId, ctx.actor.organizationId),
        isNull(arInvoices.deletedAt)
      )
    );
  if (!row) throw notFound("Invoice");
  const lines = await ctx.tx
    .select({ line: arInvoiceLines, itemName: items.name })
    .from(arInvoiceLines)
    .leftJoin(items, eq(items.id, arInvoiceLines.itemId))
    .where(eq(arInvoiceLines.invoiceId, invoiceId))
    .orderBy(asc(arInvoiceLines.lineNumber));
  const payments = await ctx.tx
    .select({
      paymentId: arPayments.id,
      paymentNumber: arPayments.paymentNumber,
      paymentDate: arPayments.paymentDate,
      amount: arPaymentApplications.amount,
      discountAmount: arPaymentApplications.discountAmount,
      status: arPayments.status,
    })
    .from(arPaymentApplications)
    .innerJoin(arPayments, eq(arPayments.id, arPaymentApplications.paymentId))
    .where(eq(arPaymentApplications.invoiceId, invoiceId))
    .orderBy(asc(arPayments.paymentDate));
  return {
    ...row.invoice,
    customerName: row.customerName,
    openBalance: row.openBalance,
    lines: lines.map((l) => ({ ...l.line, itemName: l.itemName })),
    taxLines: await taxLinesWithAgency(ctx, invoiceId),
    payments,
    credits: await creditsOnInvoice(ctx, invoiceId),
  };
}

async function taxLinesWithAgency(ctx: Ctx, invoiceId: string) {
  const lines = await taxLinesOf(ctx, { invoiceId });
  if (lines.length === 0) return [];
  const agencies = await ctx.tx
    .select({ id: taxAgencies.id, name: taxAgencies.name })
    .from(taxAgencies)
    .where(eq(taxAgencies.organizationId, ctx.actor.organizationId));
  const name = new Map(agencies.map((a) => [a.id, a.name]));
  return lines.map((l) => ({ ...l, agencyName: name.get(l.agencyId) ?? "" }));
}

async function loadInvoice(ctx: Ctx, invoiceId: string): Promise<ArInvoice> {
  const [inv] = await ctx.tx
    .select()
    .from(arInvoices)
    .where(
      and(
        eq(arInvoices.id, invoiceId),
        eq(arInvoices.organizationId, ctx.actor.organizationId),
        isNull(arInvoices.deletedAt)
      )
    )
    .for("update");
  if (!inv) throw notFound("Invoice");
  return inv;
}

async function resolveInvoice(
  ctx: Ctx,
  data: z.output<typeof CreateInvoiceSchema> | z.output<typeof UpdateInvoiceSchema>
) {
  const customer = await requireActiveCustomer(ctx, data.customerId);
  const lines = await resolveSalesLines(ctx, data.lines);
  const totals = await documentTotals(ctx, { customer, taxCodeId: data.taxCodeId, lines });
  const dueDate =
    data.dueDate ??
    format(addDays(parseISO(data.invoiceDate), customer.defaultPaymentTermsDays), "yyyy-MM-dd");
  if (dueDate < data.invoiceDate) {
    throw new AppError("invalid_input", "Due date can't be before the invoice date.");
  }

  return {
    header: {
      customerId: customer.id,
      invoiceDate: data.invoiceDate,
      dueDate,
      poNumber: data.poNumber,
      currency: data.currency ?? customer.currency,
      exchangeRate: data.exchangeRate ?? "1",
      ...totalsColumns(totals),
      memo: data.memo,
      privateNote: data.privateNote,
    },
    lines,
    totals,
  };
}

async function insertLines(
  ctx: Ctx,
  invoiceId: string,
  lines: Awaited<ReturnType<typeof resolveSalesLines>>
) {
  await ctx.tx.insert(arInvoiceLines).values(
    lines.map((l, i) => ({
      organizationId: ctx.actor.organizationId,
      invoiceId,
      lineNumber: i + 1,
      ...l,
    }))
  );
}

export async function createInvoice(
  ctx: Ctx,
  input: CreateInvoiceInput
): Promise<InvoiceDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create invoices");
  const data = CreateInvoiceSchema.parse(input);
  const org = ctx.actor.organizationId;
  const { header, lines, totals } = await resolveInvoice(ctx, data);
  const invoiceNumber = await nextNumber(ctx.tx, org, "INV");

  const [inv] = await ctx.tx
    .insert(arInvoices)
    .values({ organizationId: org, invoiceNumber, ...header, status: "draft", ...creatorFields(ctx.actor) })
    .returning();
  await insertLines(ctx, inv.id, lines);
  await writeTaxLines(ctx, { invoiceId: inv.id }, totals);

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ar.invoice.created",
      entityType: "ar_invoice",
      entityId: inv.id,
      metadata: { invoiceNumber, customerId: header.customerId, total: header.totalAmount, lineCount: lines.length },
    },
    ctx.tx
  );

  if (data.post) {
    return postOrQueueForReview(
      ctx,
      (c) => postInvoice(c, { id: inv.id }),
      () => getInvoice(ctx, { id: inv.id })
    );
  }
  return getInvoice(ctx, { id: inv.id });
}

export async function updateInvoice(ctx: Ctx, input: UpdateInvoiceInput): Promise<InvoiceDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit invoices");
  const data = UpdateInvoiceSchema.parse(input);
  const inv = await loadInvoice(ctx, data.id);
  if (inv.status !== "draft") {
    throw invalidState(`Only draft invoices can be edited (this one is ${inv.status}). Void and re-issue instead.`);
  }
  const { header, lines, totals } = await resolveInvoice(ctx, data);
  await ctx.tx
    .update(arInvoices)
    .set({ ...header, updatedAt: sql`now()` })
    .where(eq(arInvoices.id, inv.id));
  await ctx.tx.delete(arInvoiceLines).where(eq(arInvoiceLines.invoiceId, inv.id));
  await insertLines(ctx, inv.id, lines);
  await writeTaxLines(ctx, { invoiceId: inv.id }, totals);

  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.invoice.updated",
      entityType: "ar_invoice",
      entityId: inv.id,
      metadata: { invoiceNumber: inv.invoiceNumber, total: header.totalAmount },
    },
    ctx.tx
  );
  return getInvoice(ctx, { id: inv.id });
}

export async function postInvoice(ctx: Ctx, input: { id: string }): Promise<InvoiceDetail> {
  requirePermission(ctx.actor, "post", "bookkeeper", "post invoices");
  const { id: invoiceId } = IdSchema.parse(input);
  const inv = await loadInvoice(ctx, invoiceId);
  if (inv.status !== "draft") {
    throw invalidState(`Only draft invoices can be posted (this one is ${inv.status}).`);
  }
  requirePostingWithinLimit(
    ctx.actor,
    money(inv.totalAmount).times(money(inv.exchangeRate)),
    `Invoice ${inv.invoiceNumber}`
  );
  const { journalId } = await postInvoiceToGl(ctx, inv);
  await ctx.tx
    .update(arInvoices)
    .set({
      status: "open",
      postedAt: sql`now()`,
      postedBy: ctx.actor.userId,
      glJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(arInvoices.id, invoiceId));
  await autoApplyCreditsToInvoice(ctx, invoiceId);
  return getInvoice(ctx, { id: invoiceId });
}

export async function voidInvoice(
  ctx: Ctx,
  input: z.input<typeof VoidSchema>
): Promise<InvoiceDetail> {
  requirePermission(ctx.actor, "post", "admin", "void invoices");
  const { id: invoiceId, reason } = VoidSchema.parse(input);
  const inv = await loadInvoice(ctx, invoiceId);
  if (inv.status !== "open") {
    throw invalidState(
      `Only open invoices can be voided (this one is ${inv.status}).${inv.status === "paid" ? " Void its payments first." : ""}`
    );
  }
  const applied = await invoiceAppliedTotal(ctx.tx, invoiceId);
  if (applied.gt(0)) {
    throw invalidState(
      `Invoice ${inv.invoiceNumber} has ${applied.toFixed(2)} in payments and credits against it. Void those payments and unapply the credits first.`
    );
  }
  const { journalId } = await voidInvoiceFromGl(ctx, inv, reason);
  await ctx.tx
    .update(arInvoices)
    .set({
      status: "voided",
      voidedAt: sql`now()`,
      voidedBy: ctx.actor.userId,
      voidReason: reason,
      voidGlJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(arInvoices.id, invoiceId));
  return getInvoice(ctx, { id: invoiceId });
}

export async function deleteDraftInvoice(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft invoices");
  const { id: invoiceId } = IdSchema.parse(input);
  const inv = await loadInvoice(ctx, invoiceId);
  if (inv.status !== "draft") {
    throw invalidState(`Only drafts can be deleted (this one is ${inv.status}). Void it instead.`);
  }
  await ctx.tx.delete(arInvoices).where(eq(arInvoices.id, invoiceId));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.invoice.deleted",
      entityType: "ar_invoice",
      entityId: invoiceId,
      metadata: { invoiceNumber: inv.invoiceNumber },
    },
    ctx.tx
  );
  return { id: invoiceId };
}
