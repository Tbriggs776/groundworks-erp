import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requirePermission, type Ctx } from "@/lib/actor";
import { creditMemoLeftSql, invoiceSettledSql, paymentUnappliedSql } from "@/lib/ar/balances";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { isoDate } from "@/lib/schemas";

/**
 * AR and AP aging as of a date. A document counts if it was dated on or
 * before `asOf` and is posted (not draft / voided); payments count if they
 * were posted with a payment date on or before `asOf`. Buckets are days
 * past due: current (not yet due), 1–30, 31–60, 61–90, over 90.
 */

export const AgingSchema = z.object({
  asOf: isoDate.optional().describe("Age balances as of this date. Defaults to today."),
});

export type AgingBuckets = {
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  over90: string;
  total: string;
};

export type AgingDocument = {
  id: string;
  /** invoice / bill, or an unused customer credit (shown negative). */
  kind: "invoice" | "bill" | "credit_memo" | "payment";
  number: string;
  date: string;
  dueDate: string;
  daysPastDue: number;
  total: string;
  openBalance: string;
};

export type AgingParty = {
  partyId: string;
  partyName: string;
  buckets: AgingBuckets;
  documents: AgingDocument[];
};

export type AgingReport = {
  asOf: string;
  totals: AgingBuckets;
  parties: AgingParty[];
};

type Row = {
  id: string;
  kind: AgingDocument["kind"];
  number: string;
  doc_date: string;
  due_date: string;
  total: string;
  applied: string;
  party_id: string;
  party_name: string;
};

function bucketKey(daysPastDue: number): keyof Omit<AgingBuckets, "total"> {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "days1to30";
  if (daysPastDue <= 60) return "days31to60";
  if (daysPastDue <= 90) return "days61to90";
  return "over90";
}

function emptyBuckets() {
  return {
    current: money(0),
    days1to30: money(0),
    days31to60: money(0),
    days61to90: money(0),
    over90: money(0),
  };
}

function toBuckets(b: ReturnType<typeof emptyBuckets>): AgingBuckets {
  return {
    current: toDbMoney(b.current),
    days1to30: toDbMoney(b.days1to30),
    days31to60: toDbMoney(b.days31to60),
    days61to90: toDbMoney(b.days61to90),
    over90: toDbMoney(b.over90),
    total: toDbMoney(sumMoney(Object.values(b))),
  };
}

function buildReport(asOf: string, rows: Row[]): AgingReport {
  const parties = new Map<string, { name: string; b: ReturnType<typeof emptyBuckets>; docs: AgingDocument[] }>();
  const totals = emptyBuckets();
  const asOfDate = parseISO(asOf);

  for (const r of rows) {
    const open = money(r.total).minus(money(r.applied));
    if (open.isZero()) continue;
    const days = differenceInCalendarDays(asOfDate, parseISO(r.due_date));
    const key = bucketKey(days);
    const p = parties.get(r.party_id) ?? { name: r.party_name, b: emptyBuckets(), docs: [] };
    p.b[key] = p.b[key].plus(open);
    totals[key] = totals[key].plus(open);
    p.docs.push({
      id: r.id,
      kind: r.kind,
      number: r.number,
      date: r.doc_date,
      dueDate: r.due_date,
      daysPastDue: Math.max(0, days),
      total: toDbMoney(r.total),
      openBalance: toDbMoney(open),
    });
    parties.set(r.party_id, p);
  }

  return {
    asOf,
    totals: toBuckets(totals),
    parties: Array.from(parties.entries())
      .map(([partyId, p]) => ({
        partyId,
        partyName: p.name,
        buckets: toBuckets(p.b),
        documents: p.docs.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      }))
      .sort((a, b) => a.partyName.localeCompare(b.partyName)),
  };
}

const today = () => format(new Date(), "yyyy-MM-dd");

export async function arAging(ctx: Ctx, input: z.input<typeof AgingSchema> = {}): Promise<AgingReport> {
  requirePermission(ctx.actor, "read", "viewer", "run the AR aging report");
  const asOf = AgingSchema.parse(input).asOf ?? today();
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<Row>(sql`
    SELECT i.id, 'invoice' AS kind, i.invoice_number AS number, i.invoice_date::text AS doc_date,
           i.due_date::text AS due_date, i.total_amount::text AS total,
           ${invoiceSettledSql(sql`i.id`, asOf)}::text AS applied,
           c.id AS party_id, c.name AS party_name
      FROM ar_invoices i
      JOIN customers c ON c.id = i.customer_id
     WHERE i.organization_id = ${org}
       AND i.status IN ('open', 'paid')
       AND i.invoice_date <= ${asOf}::date
    UNION ALL
    -- Unused credits show as negative amounts, aged from their date.
    SELECT m.id, 'credit_memo', m.memo_number, m.memo_date::text, m.memo_date::text,
           (-${creditMemoLeftSql(sql`m.id`, sql`m.total_amount`, asOf)})::text, '0',
           c.id, c.name
      FROM credit_memos m
      JOIN customers c ON c.id = m.customer_id
     WHERE m.organization_id = ${org}
       AND m.status IN ('open', 'applied')
       AND m.memo_date <= ${asOf}::date
    UNION ALL
    SELECT p.id, 'payment', p.payment_number, p.payment_date::text, p.payment_date::text,
           (-${paymentUnappliedSql(sql`p.id`, sql`p.amount`, asOf)})::text, '0',
           c.id, c.name
      FROM ar_payments p
      JOIN customers c ON c.id = p.customer_id
     WHERE p.organization_id = ${org}
       AND p.status = 'posted'
       AND p.payment_date <= ${asOf}::date
  `);
  return buildReport(asOf, rows);
}

export async function apAging(ctx: Ctx, input: z.input<typeof AgingSchema> = {}): Promise<AgingReport> {
  requirePermission(ctx.actor, "read", "viewer", "run the AP aging report");
  const asOf = AgingSchema.parse(input).asOf ?? today();
  const rows = await ctx.tx.execute<Row>(sql`
    SELECT b.id, 'bill' AS kind, b.bill_number AS number, b.bill_date::text AS doc_date,
           b.due_date::text AS due_date, b.total_amount::text AS total,
           COALESCE((
             SELECT SUM(a.applied_amount + a.discount_amount)
               FROM ap_payment_applications a
               JOIN ap_payments p ON p.id = a.payment_id
              WHERE a.bill_id = b.id
                AND p.status = 'posted'
                AND p.payment_date <= ${asOf}::date
           ), 0)::text AS applied,
           v.id AS party_id, v.name AS party_name
      FROM ap_bills b
      JOIN vendors v ON v.id = b.vendor_id
     WHERE b.organization_id = ${ctx.actor.organizationId}
       AND b.status IN ('posted', 'paid')
       AND b.bill_date <= ${asOf}::date
  `);
  return buildReport(asOf, rows);
}
