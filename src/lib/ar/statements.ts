import { format, parseISO, startOfMonth, subMonths } from "date-fns";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, type Customer } from "@/lib/db/schema";
import { requirePermission, type Ctx } from "@/lib/actor";
import { AppError, notFound } from "@/lib/errors";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { arAging, type AgingBuckets } from "@/lib/reports/aging";
import { flag, id, isoDate } from "@/lib/schemas";

/**
 * BALANCE FORWARD STATEMENTS. A customer's opening balance, every AR
 * document in the period, and the closing balance, with aging.
 *
 * Built from the documents rather than the journals so customers see
 * document numbers, never internal notes (void reasons, memos). Each row
 * is a document's effect on Accounts Receivable, the same as its journal:
 *
 *   invoice        + total, on its date
 *   payment        − (cash + discount), on its date
 *   credit memo    − total, on its date
 *   credit refund  + total, on its date (paying out a credit)
 *   void of any    the opposite, on the date of the reversal journal
 *
 * So a statement's closing balance always equals the customer's AR
 * balance in the ledger as of the statement date.
 *
 * Aging comes from the AR aging report as of the statement date. That
 * report follows today's state of each document, so on a past-dated
 * statement a later void can leave the buckets short of the closing
 * balance; `agingTiesOut` says whether they agree, and documents print
 * the aging only when they do.
 */

export type StatementLineKind = "invoice" | "payment" | "credit_memo" | "refund" | "void";

export type StatementLine = {
  date: string;
  kind: StatementLineKind;
  /** The document this row is about (for voids, the voided one). */
  docKind: Exclude<StatementLineKind, "void">;
  docId: string;
  number: string;
  description: string;
  amount: string;
  balance: string;
};

export type Statement = {
  customer: Pick<Customer, "id" | "name" | "email" | "addresses" | "currency">;
  from: string;
  to: string;
  openingBalance: string;
  charges: string;
  credits: string;
  closingBalance: string;
  lines: StatementLine[];
  aging: AgingBuckets;
  /** The aging buckets add up to the closing balance. */
  agingTiesOut: boolean;
};

const defaults = () => {
  const now = new Date();
  return { from: format(startOfMonth(subMonths(now, 1)), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") };
};

const Period = {
  from: isoDate.optional().describe("First day of activity shown. Defaults to the first of last month."),
  to: isoDate.optional().describe("Statement date: last day of activity and the aging date. Defaults to today."),
};

export const StatementSchema = z.object({ id: id.describe("Customer id."), ...Period });
export const ListStatementsSchema = z.object({
  ...Period,
  includeZero: flag.optional().describe("Also list customers with no balance and no activity."),
});

type Effect = {
  customer_id: string;
  date: string;
  kind: StatementLineKind;
  doc_kind: Exclude<StatementLineKind, "void">;
  doc_id: string;
  number: string;
  amount: string;
  due_date: string | null;
  reference: string | null;
  ts: string;
};

/** Every AR effect dated on or before `to`, oldest first. */
async function effects(ctx: Ctx, to: string, customerId?: string): Promise<Effect[]> {
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<Effect>(sql`
    SELECT * FROM (
      SELECT i.customer_id, i.invoice_date::text AS date, 'invoice' AS kind, 'invoice' AS doc_kind, i.id AS doc_id,
             i.invoice_number AS number, i.total_amount::text AS amount, i.due_date::text AS due_date, NULL AS reference,
             i.posted_at::text AS ts
        FROM ar_invoices i
       WHERE i.organization_id = ${org} AND i.gl_journal_id IS NOT NULL AND i.status IN ('open', 'paid', 'voided')
      UNION ALL
      SELECT i.customer_id, j.journal_date::text, 'void', 'invoice', i.id, i.invoice_number, (-i.total_amount)::text, NULL, NULL,
             i.voided_at::text
        FROM ar_invoices i JOIN gl_journals j ON j.id = i.void_gl_journal_id
       WHERE i.organization_id = ${org} AND i.status = 'voided'
      UNION ALL
      SELECT p.customer_id, p.payment_date::text, 'payment', 'payment', p.id, p.payment_number,
             (-(p.amount + p.discount_amount))::text, NULL, p.reference, p.posted_at::text
        FROM ar_payments p
       WHERE p.organization_id = ${org} AND p.gl_journal_id IS NOT NULL AND p.status IN ('posted', 'voided')
      UNION ALL
      SELECT p.customer_id, j.journal_date::text, 'void', 'payment', p.id, p.payment_number,
             (p.amount + p.discount_amount)::text, NULL, NULL, p.voided_at::text
        FROM ar_payments p JOIN gl_journals j ON j.id = p.void_gl_journal_id
       WHERE p.organization_id = ${org} AND p.status = 'voided'
      UNION ALL
      SELECT m.customer_id, m.memo_date::text, 'credit_memo', 'credit_memo', m.id, m.memo_number, (-m.total_amount)::text,
             NULL, NULL, m.posted_at::text
        FROM credit_memos m
       WHERE m.organization_id = ${org} AND m.gl_journal_id IS NOT NULL AND m.status IN ('open', 'applied', 'voided')
      UNION ALL
      SELECT m.customer_id, j.journal_date::text, 'void', 'credit_memo', m.id, m.memo_number, m.total_amount::text,
             NULL, NULL, m.voided_at::text
        FROM credit_memos m JOIN gl_journals j ON j.id = m.void_gl_journal_id
       WHERE m.organization_id = ${org} AND m.status = 'voided'
      UNION ALL
      SELECT r.customer_id, r.refund_date::text, 'refund', 'refund', r.id, r.refund_number, r.total_amount::text,
             NULL, r.reference, r.posted_at::text
        FROM refund_receipts r
       WHERE r.organization_id = ${org} AND r.kind = 'credit' AND r.gl_journal_id IS NOT NULL AND r.status IN ('posted', 'voided')
      UNION ALL
      SELECT r.customer_id, j.journal_date::text, 'void', 'refund', r.id, r.refund_number, (-r.total_amount)::text,
             NULL, NULL, r.voided_at::text
        FROM refund_receipts r JOIN gl_journals j ON j.id = r.void_gl_journal_id
       WHERE r.organization_id = ${org} AND r.kind = 'credit' AND r.status = 'voided'
    ) e
    WHERE e.date <= ${to}
      ${customerId ? sql`AND e.customer_id = ${customerId}` : sql``}
    ORDER BY e.date, e.ts NULLS LAST, e.number
  `);
  return rows;
}

const DOC_LABEL: Record<Effect["doc_kind"], string> = {
  invoice: "Invoice",
  payment: "Payment",
  credit_memo: "Credit memo",
  refund: "Refund",
};

function describe(e: Effect): string {
  if (e.kind === "void") return `Void of ${DOC_LABEL[e.doc_kind].toLowerCase()} ${e.number}`;
  if (e.kind === "invoice") return `Invoice ${e.number}${e.due_date ? `, due ${format(parseISO(e.due_date), "MMM d, yyyy")}` : ""}`;
  if (e.kind === "payment") return `Payment ${e.number}${e.reference ? ` (ref ${e.reference})` : ""}`;
  if (e.kind === "credit_memo") return `Credit memo ${e.number}`;
  return `Refund of credit ${e.number}`;
}

function build(customer: Statement["customer"], from: string, to: string, rows: Effect[], aging: AgingBuckets): Statement {
  let balance = sumMoney(rows.filter((r) => r.date < from).map((r) => r.amount));
  const openingBalance = toDbMoney(balance);
  const inPeriod = rows.filter((r) => r.date >= from);
  const lines = inPeriod.map((r) => {
    balance = balance.plus(money(r.amount));
    return {
      date: r.date,
      kind: r.kind,
      docKind: r.doc_kind,
      docId: r.doc_id,
      number: r.number,
      description: describe(r),
      amount: toDbMoney(r.amount),
      balance: toDbMoney(balance),
    };
  });
  return {
    customer,
    from,
    to,
    openingBalance,
    charges: toDbMoney(sumMoney(inPeriod.filter((r) => money(r.amount).gt(0)).map((r) => r.amount))),
    credits: toDbMoney(sumMoney(inPeriod.filter((r) => money(r.amount).lt(0)).map((r) => r.amount)).abs()),
    closingBalance: toDbMoney(balance),
    lines,
    aging,
    agingTiesOut: money(aging.total).eq(balance),
  };
}

const NO_AGING: AgingBuckets = { current: "0", days1to30: "0", days31to60: "0", days61to90: "0", over90: "0", total: "0" };

function period(input: { from?: string; to?: string }) {
  const d = defaults();
  const from = input.from ?? d.from;
  const to = input.to ?? d.to;
  if (from > to) throw new AppError("invalid_input", "The start date must be on or before the statement date.");
  return { from, to };
}

const customerCols = {
  id: customers.id,
  name: customers.name,
  email: customers.email,
  addresses: customers.addresses,
  currency: customers.currency,
};

export async function customerStatement(ctx: Ctx, input: z.input<typeof StatementSchema>): Promise<Statement> {
  requirePermission(ctx.actor, "read", "viewer", "view customer statements");
  const d = StatementSchema.parse(input);
  const { from, to } = period(d);
  const [customer] = await ctx.tx
    .select(customerCols)
    .from(customers)
    .where(and(eq(customers.id, d.id), eq(customers.organizationId, ctx.actor.organizationId), isNull(customers.deletedAt)));
  if (!customer) throw notFound("Customer");
  const aging = (await arAging(ctx, { asOf: to })).parties.find((p) => p.partyId === customer.id)?.buckets ?? NO_AGING;
  return build(customer, from, to, await effects(ctx, to, customer.id), aging);
}

/**
 * Statements for every customer with a balance or activity in the period
 * (or all of them, with includeZero), alphabetical.
 */
export async function listStatements(ctx: Ctx, input: z.input<typeof ListStatementsSchema>): Promise<Statement[]> {
  requirePermission(ctx.actor, "read", "viewer", "view customer statements");
  const d = ListStatementsSchema.parse(input);
  const { from, to } = period(d);
  const all = await ctx.tx
    .select(customerCols)
    .from(customers)
    .where(and(eq(customers.organizationId, ctx.actor.organizationId), isNull(customers.deletedAt)))
    .orderBy(asc(customers.name));
  const byCustomer = new Map<string, Effect[]>();
  for (const e of await effects(ctx, to)) {
    const list = byCustomer.get(e.customer_id) ?? [];
    list.push(e);
    byCustomer.set(e.customer_id, list);
  }
  const aging = new Map((await arAging(ctx, { asOf: to })).parties.map((p) => [p.partyId, p.buckets]));
  return all
    .map((c) => build(c, from, to, byCustomer.get(c.id) ?? [], aging.get(c.id) ?? NO_AGING))
    .filter((s) => d.includeZero || s.lines.length > 0 || !money(s.closingBalance).isZero());
}
