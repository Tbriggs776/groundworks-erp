import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { items, salesTaxLines, type Customer, type DimensionTag } from "@/lib/db/schema";
import { auditFields, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { requireDimensionTags, requireLineAccounts, sourceCodeId } from "@/lib/gl/lookups";
import { createAndPostJournal, reverseJournal, type JournalLineInput } from "@/lib/gl/posting";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { computeTax, type ComputedTax } from "@/lib/sales-tax/rates";
import { amount, id, optionalText } from "@/lib/schemas";

/**
 * What every sales document (invoice, sales receipt, credit memo, refund
 * receipt) shares: line resolution from items, sales tax, and posting.
 *
 * A line can be as small as { itemId } (price, description, income
 * account, and taxable come from the item) or fully explicit.
 */

const SalesLineFields = z.object({
  itemId: id.optional().describe("Product / service. Supplies defaults for the fields below."),
  description: optionalText(1000),
  quantity: amount.optional().describe("Defaults to 1."),
  unitPrice: amount
    .optional()
    .describe("Defaults to the item's sales price. Negative for a discount line."),
  accountId: id.optional().describe("Income account. Defaults to the item's income account."),
  taxable: z
    .boolean()
    .optional()
    .describe("Charge sales tax on this line. Defaults to the item's setting; lines without an item aren't taxable unless set."),
  dimensions: z
    .array(z.object({ dimensionId: id, valueId: id }))
    .optional()
    .describe("Class / Location / Department / Project tags."),
});

const itemOrAccount = [
  (l: { itemId?: string; accountId?: string }) => Boolean(l.itemId || l.accountId),
  { message: "Each line needs an itemId or an accountId." },
] as const;

export const SalesLineSchema = SalesLineFields.refine(...itemOrAccount);

/** Invoice lines can also say which estimate line they bill (progress invoicing). */
export const InvoiceLineSchema = SalesLineFields.extend({
  estimateLineId: id
    .optional()
    .describe("Estimate line this bills. Set by create_invoice_from_estimate; keep it when editing that invoice."),
}).refine(...itemOrAccount);

export const taxCodeField = id
  .nullable()
  .optional()
  .describe("Sales tax rate (from list_tax_rates). Omit to use the customer's default rate; null for no tax.");

export type SalesLineInput = z.output<typeof SalesLineSchema>;

export type ResolvedLine = {
  itemId: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  accountId: string;
  taxable: boolean;
  dimensions: DimensionTag[];
};

/** qty × price, rounded half-up to cents like every document the customer has ever seen. */
export function lineAmount(quantity: string, unitPrice: string): string {
  return toDbMoney(money(quantity).times(money(unitPrice)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
}

export async function resolveSalesLines(ctx: Ctx, input: SalesLineInput[]): Promise<ResolvedLine[]> {
  const org = ctx.actor.organizationId;
  const itemIds = input.map((l) => l.itemId).filter((x): x is string => !!x);
  const itemRows = itemIds.length
    ? await ctx.tx.select().from(items).where(and(eq(items.organizationId, org), inArray(items.id, itemIds)))
    : [];
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  const lines = input.map((l, i) => {
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    if (l.itemId && !item) throw new AppError("not_found", `Line ${i + 1}: item not found.`);
    if (item && !item.isActive) throw new AppError("invalid_input", `Line ${i + 1}: ${item.name} is inactive.`);
    const unitPrice = l.unitPrice ?? item?.salesPrice ?? null;
    if (unitPrice === null) {
      throw new AppError(
        "invalid_input",
        `Line ${i + 1}: unitPrice is required${item ? ` (${item.name} has no default price)` : ""}.`
      );
    }
    const quantity = l.quantity ?? "1.0000";
    if (money(quantity).lte(0)) throw new AppError("invalid_input", `Line ${i + 1}: quantity must be greater than zero.`);
    return {
      itemId: item?.id ?? null,
      description: l.description ?? item?.description ?? item?.name ?? null,
      quantity,
      unitPrice: toDbMoney(unitPrice),
      amount: lineAmount(quantity, unitPrice),
      accountId: l.accountId ?? item!.incomeAccountId,
      taxable: l.taxable ?? item?.taxable ?? false,
      dimensions: (l.dimensions ?? []) as DimensionTag[],
    };
  });

  await requireLineAccounts(ctx.tx, org, lines.map((l) => l.accountId));
  await requireDimensionTags(ctx.tx, org, lines.flatMap((l) => l.dimensions));
  return lines;
}

export type DocTotals = ComputedTax & { subtotalAmount: string; totalAmount: string };

/** Subtotal, tax (on the taxable total), and total for a document's lines. */
export async function documentTotals(
  ctx: Ctx,
  opts: { customer: Pick<Customer, "taxExempt" | "defaultTaxCodeId"> | null; taxCodeId: string | null | undefined; lines: ResolvedLine[] }
): Promise<DocTotals> {
  const subtotal = sumMoney(opts.lines.map((l) => l.amount));
  if (subtotal.lte(0)) throw new AppError("invalid_input", "The total must be greater than zero.");
  const taxCodeId = opts.taxCodeId === undefined ? (opts.customer?.defaultTaxCodeId ?? null) : opts.taxCodeId;
  const tax = await computeTax(ctx, {
    taxCodeId,
    exempt: opts.customer?.taxExempt ?? false,
    taxable: sumMoney(opts.lines.filter((l) => l.taxable).map((l) => l.amount)),
  });
  return { ...tax, subtotalAmount: toDbMoney(subtotal), totalAmount: toDbMoney(subtotal.plus(money(tax.taxAmount))) };
}

/** The header columns a document stores from its totals. */
export function totalsColumns(t: DocTotals) {
  return {
    subtotalAmount: t.subtotalAmount,
    taxCodeId: t.taxCodeId,
    taxExempt: t.taxExempt,
    taxableAmount: t.taxableAmount,
    taxAmount: t.taxAmount,
    totalAmount: t.totalAmount,
  };
}

export type TaxDocRef =
  | { invoiceId: string }
  | { salesReceiptId: string }
  | { creditMemoId: string }
  | { refundId: string };

function refWhere(ref: TaxDocRef) {
  if ("invoiceId" in ref) return eq(salesTaxLines.invoiceId, ref.invoiceId);
  if ("salesReceiptId" in ref) return eq(salesTaxLines.salesReceiptId, ref.salesReceiptId);
  if ("creditMemoId" in ref) return eq(salesTaxLines.creditMemoId, ref.creditMemoId);
  return eq(salesTaxLines.refundId, ref.refundId);
}

/** Replace a document's frozen tax lines. */
export async function writeTaxLines(ctx: Ctx, ref: TaxDocRef, tax: ComputedTax) {
  await ctx.tx.delete(salesTaxLines).where(refWhere(ref));
  if (tax.lines.length === 0) return;
  await ctx.tx
    .insert(salesTaxLines)
    .values(tax.lines.map((l) => ({ organizationId: ctx.actor.organizationId, ...ref, ...l })));
}

export async function taxLinesOf(ctx: Ctx, ref: TaxDocRef) {
  return ctx.tx.select().from(salesTaxLines).where(and(eq(salesTaxLines.organizationId, ctx.actor.organizationId), refWhere(ref)));
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Post a sales document. A sale credits income and tax and debits the
 * counter account (AR or a bank); a return does the opposite. A negative
 * line (a discount) flips its side.
 */
export async function postSalesDocument(
  ctx: Ctx,
  doc: {
    direction: "sale" | "return";
    ref: TaxDocRef;
    number: string;
    label: string;
    date: string;
    currency: string;
    exchangeRate: string;
    total: string;
    customerId: string | null;
    counter: { accountId: string; bank: boolean; memo: string };
    lines: Array<Pick<ResolvedLine, "accountId" | "amount" | "description" | "dimensions">>;
    sourceCode: "SJ" | "CR" | "CD";
    source: "ar" | "cash_receipt" | "cash_disbursement";
    auditEvent: string;
    entityType: string;
    entityId: string;
  }
): Promise<{ journalId: string; journalNumber: string }> {
  const { actor, tx } = ctx;
  const org = actor.organizationId;
  const sale = doc.direction === "sale";
  const side = (amt: Decimal, creditWhenPositive: boolean) =>
    amt.gt(0) === creditWhenPositive ? { credit: toDbMoney(amt.abs()) } : { debit: toDbMoney(amt.abs()) };

  const jeLines: JournalLineInput[] = [
    {
      accountId: doc.counter.accountId,
      ...side(money(doc.total), !sale),
      memo: doc.counter.memo,
      customerId: doc.customerId ?? undefined,
      bankAccountId: doc.counter.bank ? doc.counter.accountId : undefined,
    },
  ];
  for (const l of doc.lines) {
    const amt = money(l.amount);
    if (amt.isZero()) continue;
    jeLines.push({
      accountId: l.accountId,
      ...side(amt, sale),
      memo: l.description ?? undefined,
      customerId: doc.customerId ?? undefined,
      dimensions: l.dimensions.length > 0 ? l.dimensions : undefined,
    });
  }
  for (const t of await taxLinesOf(ctx, doc.ref)) {
    const amt = money(t.taxAmount);
    if (amt.isZero()) continue;
    jeLines.push({
      accountId: t.liabilityAccountId,
      ...side(amt, sale),
      memo: `Sales tax ${money(t.ratePercent).toString()}% on ${doc.label}`,
      customerId: doc.customerId ?? undefined,
    });
  }

  const result = await createAndPostJournal(
    {
      organizationId: org,
      actorId: actor.userId,
      actor,
      journalDate: doc.date,
      sourceCodeId: await sourceCodeId(tx, org, doc.sourceCode),
      source: doc.source,
      description: doc.label,
      currency: doc.currency,
      exchangeRate: doc.exchangeRate,
      documentNo: doc.number,
      lines: jeLines,
    },
    tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(actor),
      event: doc.auditEvent,
      entityType: doc.entityType,
      entityId: doc.entityId,
      metadata: { number: doc.number, journalId: result.journalId, total: doc.total },
    },
    tx
  );
  return { journalId: result.journalId, journalNumber: result.journalNumber };
}

/** Void = post a reversal of the document's journal, dated today. */
export async function reverseSalesDocument(
  ctx: Ctx,
  doc: { glJournalId: string | null; label: string; reason: string; auditEvent: string; entityType: string; entityId: string; number: string }
): Promise<{ journalId: string }> {
  const { actor, tx } = ctx;
  if (!doc.glJournalId) throw new AppError("invalid_state", `${doc.label} has no posted journal to reverse.`);
  const result = await reverseJournal(
    doc.glJournalId,
    { actorId: actor.userId, actor, organizationId: actor.organizationId, description: `Void of ${doc.label}: ${doc.reason}` },
    tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  await writeAudit(
    {
      organizationId: actor.organizationId,
      ...auditFields(actor),
      event: doc.auditEvent,
      entityType: doc.entityType,
      entityId: doc.entityId,
      metadata: { number: doc.number, reason: doc.reason, reversalJournalId: result.journalId },
    },
    tx
  );
  return { journalId: result.journalId };
}
