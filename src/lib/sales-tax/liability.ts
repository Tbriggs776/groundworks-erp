import { format, startOfQuarter } from "date-fns";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, organizations, salesTaxPayments, taxAgencies, type SalesTaxPayment } from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { requireBankingAccount } from "@/lib/banking/common";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { sourceCodeId } from "@/lib/gl/lookups";
import { nextNumber } from "@/lib/gl/number-series";
import { createAndPostJournal, reverseJournal } from "@/lib/gl/posting";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { id, isoDate, optionalText, pagination, positiveAmount, toPage, type Page } from "@/lib/schemas";
import { loadAgency } from "./rates";

/**
 * SALES TAX OWED AND PAID.
 *
 * Collected = tax on posted invoices and sales receipts, less tax on
 * posted credit memos and refunds, by document date (accrual). Owed to an
 * agency = collected to date − paid to date.
 */

export const LiabilityReportSchema = z.object({
  from: isoDate.optional().describe("Default: start of the current quarter."),
  to: isoDate.optional().describe("Default: today."),
});

export type LiabilityRate = {
  taxRateId: string;
  name: string;
  ratePercent: string;
  grossSales: string;
  nonTaxableSales: string;
  taxableSales: string;
  taxCollected: string;
};
export type LiabilityAgency = {
  agencyId: string;
  agencyName: string;
  liabilityAccountId: string;
  rates: LiabilityRate[];
  taxCollected: string;
  paymentsInPeriod: string;
  /** Owed as of `to`: collected to date − paid to date. */
  balanceOwed: string;
};
export type LiabilityReport = { from: string; to: string; agencies: LiabilityAgency[]; totalOwed: string };

/** Each tax line with its document's sign, date, and gross sales. Voided and draft documents drop out. */
const signedTaxLines = (org: string) => sql`
  SELECT l.agency_id, l.tax_rate_id, s.sign * l.taxable_amount AS taxable, s.sign * l.tax_amount AS tax,
         s.sign * s.gross AS gross, s.doc_date
    FROM sales_tax_lines l
    JOIN LATERAL (
      SELECT 1 AS sign, i.invoice_date AS doc_date, i.subtotal_amount AS gross FROM ar_invoices i
       WHERE i.id = l.invoice_id AND i.status IN ('open', 'paid')
      UNION ALL
      SELECT 1, r.receipt_date, r.subtotal_amount FROM sales_receipts r
       WHERE r.id = l.sales_receipt_id AND r.status = 'posted'
      UNION ALL
      SELECT -1, m.memo_date, m.subtotal_amount FROM credit_memos m
       WHERE m.id = l.credit_memo_id AND m.status IN ('open', 'applied')
      UNION ALL
      SELECT -1, f.refund_date, f.subtotal_amount FROM refund_receipts f
       WHERE f.id = l.refund_id AND f.status = 'posted'
    ) s ON true
   WHERE l.organization_id = ${org}`;

export async function salesTaxLiability(ctx: Ctx, input: z.input<typeof LiabilityReportSchema> = {}): Promise<LiabilityReport> {
  requirePermission(ctx.actor, "read", "viewer", "run the sales tax liability report");
  const f = LiabilityReportSchema.parse(input);
  const to = f.to ?? format(new Date(), "yyyy-MM-dd");
  const from = f.from ?? format(startOfQuarter(new Date()), "yyyy-MM-dd");
  const org = ctx.actor.organizationId;

  const rates = await ctx.tx.execute<{
    agency_id: string;
    tax_rate_id: string;
    gross: string;
    taxable: string;
    tax: string;
  }>(sql`
    SELECT t.agency_id, t.tax_rate_id, SUM(t.gross)::text AS gross, SUM(t.taxable)::text AS taxable, SUM(t.tax)::text AS tax
      FROM (${signedTaxLines(org)}) t
     WHERE t.doc_date BETWEEN ${from}::date AND ${to}::date
     GROUP BY t.agency_id, t.tax_rate_id`);
  const collectedToDate = await ctx.tx.execute<{ agency_id: string; tax: string }>(sql`
    SELECT t.agency_id, SUM(t.tax)::text AS tax FROM (${signedTaxLines(org)}) t
     WHERE t.doc_date <= ${to}::date GROUP BY t.agency_id`);
  const paid = await ctx.tx.execute<{ agency_id: string; in_period: string; to_date: string }>(sql`
    SELECT agency_id,
           COALESCE(SUM(amount) FILTER (WHERE payment_date BETWEEN ${from}::date AND ${to}::date), 0)::text AS in_period,
           COALESCE(SUM(amount) FILTER (WHERE payment_date <= ${to}::date), 0)::text AS to_date
      FROM sales_tax_payments
     WHERE organization_id = ${org} AND status = 'posted'
     GROUP BY agency_id`);
  const names = await ctx.tx.execute<{ id: string; name: string; rate: string }>(sql`
    SELECT id, name, rate_percent::text AS rate FROM tax_rates WHERE organization_id = ${org}`);
  const agencies = await ctx.tx.select().from(taxAgencies).where(eq(taxAgencies.organizationId, org));

  const rateName = new Map(names.map((n) => [n.id, n]));
  const collected = new Map(collectedToDate.map((c) => [c.agency_id, money(c.tax)]));
  const payments = new Map(paid.map((p) => [p.agency_id, p]));
  const out: LiabilityAgency[] = agencies
    .map((a) => {
      const rows = rates
        .filter((r) => r.agency_id === a.id)
        .map((r) => ({
          taxRateId: r.tax_rate_id,
          name: rateName.get(r.tax_rate_id)?.name ?? "",
          ratePercent: rateName.get(r.tax_rate_id)?.rate ?? "0",
          grossSales: toDbMoney(r.gross),
          nonTaxableSales: toDbMoney(money(r.gross).minus(money(r.taxable))),
          taxableSales: toDbMoney(r.taxable),
          taxCollected: toDbMoney(r.tax),
        }))
        .sort((x, y) => x.name.localeCompare(y.name));
      const p = payments.get(a.id);
      return {
        agencyId: a.id,
        agencyName: a.name,
        liabilityAccountId: a.liabilityAccountId,
        rates: rows,
        taxCollected: toDbMoney(sumMoney(rows.map((r) => r.taxCollected))),
        paymentsInPeriod: toDbMoney(p?.in_period ?? 0),
        balanceOwed: toDbMoney((collected.get(a.id) ?? money(0)).minus(money(p?.to_date ?? 0))),
      };
    })
    .filter((a) => a.rates.length > 0 || !money(a.balanceOwed).isZero() || agencies.find((x) => x.id === a.agencyId)?.isActive)
    .sort((x, y) => x.agencyName.localeCompare(y.agencyName));
  return { from, to, agencies: out, totalOwed: toDbMoney(sumMoney(out.map((a) => a.balanceOwed))) };
}

// ---------------------------------------------------------------------------
// Paying an agency
// ---------------------------------------------------------------------------

export const RecordTaxPaymentSchema = z.object({
  agencyId: id,
  paymentDate: isoDate,
  periodEnd: isoDate.describe("Last day of the filing period this pays, e.g. 2026-09-30 for Q3."),
  amount: positiveAmount,
  bankAccountId: id.describe("Bank account the payment comes out of."),
  reference: optionalText(100).describe("Confirmation or check number."),
  memo: optionalText(500),
});
export const ListTaxPaymentsSchema = z.object({ agencyId: id.optional(), ...pagination });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type TaxPaymentRow = SalesTaxPayment & { agencyName: string; bankAccountName: string };

export async function listTaxPayments(ctx: Ctx, input: z.input<typeof ListTaxPaymentsSchema> = {}): Promise<Page<TaxPaymentRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list sales tax payments");
  const f = ListTaxPaymentsSchema.parse(input);
  const rows = await ctx.tx
    .select({ p: salesTaxPayments, agencyName: taxAgencies.name, bankAccountName: accounts.name })
    .from(salesTaxPayments)
    .innerJoin(taxAgencies, eq(taxAgencies.id, salesTaxPayments.agencyId))
    .innerJoin(accounts, eq(accounts.id, salesTaxPayments.bankAccountId))
    .where(and(eq(salesTaxPayments.organizationId, ctx.actor.organizationId), f.agencyId ? eq(salesTaxPayments.agencyId, f.agencyId) : undefined))
    .orderBy(desc(salesTaxPayments.paymentDate), desc(salesTaxPayments.paymentNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map((r) => ({ ...r.p, agencyName: r.agencyName, bankAccountName: r.bankAccountName })), f.limit, f.offset);
}

async function getTaxPayment(ctx: Ctx, paymentId: string): Promise<TaxPaymentRow> {
  const [r] = await ctx.tx
    .select({ p: salesTaxPayments, agencyName: taxAgencies.name, bankAccountName: accounts.name })
    .from(salesTaxPayments)
    .innerJoin(taxAgencies, eq(taxAgencies.id, salesTaxPayments.agencyId))
    .innerJoin(accounts, eq(accounts.id, salesTaxPayments.bankAccountId))
    .where(and(eq(salesTaxPayments.id, paymentId), eq(salesTaxPayments.organizationId, ctx.actor.organizationId)));
  if (!r) throw notFound("Sales tax payment");
  return { ...r.p, agencyName: r.agencyName, bankAccountName: r.bankAccountName };
}

/** Pay an agency: Dr its liability account / Cr bank. Posts at once. */
export async function recordTaxPayment(ctx: Ctx, input: z.input<typeof RecordTaxPaymentSchema>): Promise<TaxPaymentRow> {
  requirePermission(ctx.actor, "post", "accountant", "record sales tax payments");
  const d = RecordTaxPaymentSchema.parse(input);
  const org = ctx.actor.organizationId;
  const agency = await loadAgency(ctx, d.agencyId);
  const bank = await requireBankingAccount(ctx.tx, org, d.bankAccountId, { label: "Payment account" });
  requirePostingWithinLimit(ctx.actor, money(d.amount), `Sales tax payment to ${agency.name}`);
  const [company] = await ctx.tx.select({ base: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, org));
  const paymentNumber = await nextNumber(ctx.tx, org, "STP");
  const memo = `Sales tax to ${agency.name} for the period ending ${d.periodEnd}`;
  const result = await createAndPostJournal(
    {
      organizationId: org,
      actorId: ctx.actor.userId,
      actor: ctx.actor,
      journalDate: d.paymentDate,
      sourceCodeId: await sourceCodeId(ctx.tx, org, "CD"),
      source: "cash_disbursement",
      description: memo,
      currency: bank.currency ?? company.base,
      exchangeRate: "1",
      documentNo: d.reference ?? paymentNumber,
      lines: [
        { accountId: agency.liabilityAccountId, debit: toDbMoney(d.amount), memo },
        { accountId: bank.id, credit: toDbMoney(d.amount), memo: `${paymentNumber} · ${agency.name}`, bankAccountId: bank.id },
      ],
    },
    ctx.tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  const [p] = await ctx.tx
    .insert(salesTaxPayments)
    .values({
      organizationId: org,
      paymentNumber,
      agencyId: agency.id,
      paymentDate: d.paymentDate,
      periodEnd: d.periodEnd,
      amount: d.amount,
      bankAccountId: bank.id,
      reference: d.reference,
      memo: d.memo,
      status: "posted",
      postedAt: sql`now()`,
      glJournalId: result.journalId,
      ...creatorFields(ctx.actor),
    })
    .returning();
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "sales_tax.payment.recorded",
      entityType: "sales_tax_payment",
      entityId: p.id,
      metadata: { paymentNumber, agency: agency.name, amount: p.amount, periodEnd: p.periodEnd, journalId: result.journalId },
    },
    ctx.tx
  );
  return getTaxPayment(ctx, p.id);
}

export async function voidTaxPayment(ctx: Ctx, input: z.input<typeof VoidSchema>): Promise<TaxPaymentRow> {
  requirePermission(ctx.actor, "post", "admin", "void sales tax payments");
  const { id: paymentId, reason } = VoidSchema.parse(input);
  const p = await getTaxPayment(ctx, paymentId);
  if (p.status !== "posted") throw invalidState("This payment is already voided.");
  const result = await reverseJournal(
    p.glJournalId!,
    { actorId: ctx.actor.userId, actor: ctx.actor, organizationId: ctx.actor.organizationId, description: `Void of sales tax payment ${p.paymentNumber}: ${reason}` },
    ctx.tx
  );
  if (!result.ok) throw new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
  await ctx.tx
    .update(salesTaxPayments)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId: result.journalId, updatedAt: sql`now()` })
    .where(eq(salesTaxPayments.id, p.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "sales_tax.payment.voided",
      entityType: "sales_tax_payment",
      entityId: p.id,
      metadata: { paymentNumber: p.paymentNumber, reason, reversalJournalId: result.journalId },
    },
    ctx.tx
  );
  return getTaxPayment(ctx, p.id);
}
