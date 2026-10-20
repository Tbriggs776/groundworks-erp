import type Decimal from "decimal.js";
import { format, parseISO } from "date-fns";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, auditLog, profiles } from "@/lib/db/schema";
import { requirePermission, type Ctx } from "@/lib/actor";
import { auditRef } from "@/lib/audit-query";
import { money, sumMoney } from "@/lib/money";
import { id } from "@/lib/schemas";
import { AgingSchema, apAging, arAging, type AgingDocument, type AgingReport } from "./aging";
import { Range, range, rangeLabel } from "./statements";
import { fmt2, type ReportRow, type ReportTable } from "./table";

/**
 * Who bought, what sold, who was paid, what's still open, and who did what.
 *
 *   sales by customer   income account postings by customer (the ledger)
 *   sales by item       income lines of sales documents by item
 *   expenses by vendor  expense and COGS postings by vendor (the ledger)
 *   open invoices       AR aging documents, listed per customer
 *   unpaid bills        AP aging documents, listed per vendor
 *   audit trail         the company's audit log for a date range
 *
 * Ledger reports read posted and reversed journals in base currency by
 * journal date, with a row for postings without a customer or vendor, so
 * their totals match the P&L. Sales by item counts each document on its
 * journal's date and takes a voided one back on the void's date, so it
 * matches the ledger too.
 */

export const SalesByCustomerSchema = z.object({ ...Range });
export const SalesByItemSchema = z.object({ ...Range });
export const ExpensesByVendorSchema = z.object({ ...Range });
export const OpenDocumentsSchema = AgingSchema;
export const AuditTrailSchema = z.object({
  ...Range,
  actorType: z.enum(["user", "agent", "system"]).optional().describe("Only events by people, agents, or the system."),
  agentId: id.optional().describe("Only events by this agent."),
});

const REVENUE = sql`('operating_revenue', 'other_revenue')`;

const share = (v: Decimal, total: Decimal) => (total.isZero() ? null : `${v.div(total).times(100).toFixed(1)}%`);

type PartyRow = { party_id: string | null; name: string | null; amount: string };

/** One row per customer or vendor, then the postings without one, then the total. */
function partyTable(
  rows: PartyRow[],
  o: { title: string; subtitle: string; labelColumn: string; amount: string; share: string; none: string; removed: string; notes: string[] }
): ReportTable {
  const named = rows
    .filter((r) => r.party_id)
    .map((r) => ({ label: r.name ?? o.removed, amount: money(r.amount) }))
    .filter((x) => !x.amount.isZero())
    .sort((a, b) => a.label.localeCompare(b.label));
  const none = sumMoney(rows.filter((r) => !r.party_id).map((r) => r.amount));
  const total = sumMoney([...named.map((x) => x.amount), none]);
  const out: ReportRow[] = named.map((x) => ({ kind: "account", label: x.label, values: [fmt2(x.amount), share(x.amount, total)] }));
  if (!none.isZero()) out.push({ kind: "account", label: o.none, values: [fmt2(none), share(none, total)] });
  out.push({ kind: "total", label: "Total", values: [fmt2(total), total.isZero() ? null : "100.0%"] });
  return { title: o.title, subtitle: o.subtitle, labelColumn: o.labelColumn, columns: [o.amount, o.share], columnKinds: ["money", "number"], rows: out, notes: o.notes };
}

export async function salesByCustomer(ctx: Ctx, input: z.input<typeof SalesByCustomerSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the sales by customer report");
  const { from, to } = range(SalesByCustomerSchema.parse(input));
  const rows = await ctx.tx.execute<PartyRow>(sql`
    SELECT l.customer_id AS party_id, c.name, SUM(l.credit_local - l.debit_local)::text AS amount
      FROM gl_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id
      LEFT JOIN customers c ON c.id = l.customer_id AND c.organization_id = l.organization_id
     WHERE l.organization_id = ${ctx.actor.organizationId}
       AND j.status IN ('posted', 'reversed')
       AND j.journal_date BETWEEN ${from}::date AND ${to}::date
       AND a.category = 'income_statement'
       AND a.subcategory IN ${REVENUE}
     GROUP BY 1, 2
  `);
  return partyTable(rows, {
    title: "Sales by Customer",
    subtitle: rangeLabel(from, to),
    labelColumn: "Customer",
    amount: "Sales",
    share: "% of sales",
    none: "No customer",
    removed: "Removed customer",
    notes: ["Income account postings, net of credit memos, refunds, discounts, and voids, before sales tax. The total matches revenue on the P&L."],
  });
}

export async function expensesByVendor(ctx: Ctx, input: z.input<typeof ExpensesByVendorSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the expenses by vendor report");
  const { from, to } = range(ExpensesByVendorSchema.parse(input));
  const rows = await ctx.tx.execute<PartyRow>(sql`
    SELECT l.vendor_id AS party_id, v.name, SUM(l.debit_local - l.credit_local)::text AS amount
      FROM gl_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id
      LEFT JOIN vendors v ON v.id = l.vendor_id AND v.organization_id = l.organization_id
     WHERE l.organization_id = ${ctx.actor.organizationId}
       AND j.status IN ('posted', 'reversed')
       AND j.journal_date BETWEEN ${from}::date AND ${to}::date
       AND a.category = 'income_statement'
       AND a.subcategory NOT IN ${REVENUE}
     GROUP BY 1, 2
  `);
  return partyTable(rows, {
    title: "Expenses by Vendor",
    subtitle: rangeLabel(from, to),
    labelColumn: "Vendor",
    amount: "Expenses",
    share: "% of expenses",
    none: "No vendor",
    removed: "Removed vendor",
    notes: ["Expense and cost of goods sold postings from bills, expenses, and checks, net of vendor credits and voids. The total matches COGS plus expenses on the P&L."],
  });
}

export async function salesByItem(ctx: Ctx, input: z.input<typeof SalesByItemSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the sales by item report");
  const { from, to } = range(SalesByItemSchema.parse(input));
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<{ item_id: string | null; name: string | null; sku: string | null; quantity: string; amount: string }>(sql`
    WITH lines AS (
      SELECT l.item_id, l.quantity, l.amount, l.account_id, d.exchange_rate, 1 AS sign, d.gl_journal_id, d.void_gl_journal_id
        FROM ar_invoice_lines l JOIN ar_invoices d ON d.id = l.invoice_id
       WHERE d.organization_id = ${org}
      UNION ALL
      SELECT l.item_id, l.quantity, l.amount, l.account_id, d.exchange_rate, 1, d.gl_journal_id, d.void_gl_journal_id
        FROM sales_receipt_lines l JOIN sales_receipts d ON d.id = l.receipt_id
       WHERE d.organization_id = ${org}
      UNION ALL
      SELECT l.item_id, l.quantity, l.amount, l.account_id, d.exchange_rate, -1, d.gl_journal_id, d.void_gl_journal_id
        FROM credit_memo_lines l JOIN credit_memos d ON d.id = l.credit_memo_id
       WHERE d.organization_id = ${org}
      UNION ALL
      SELECT l.item_id, l.quantity, l.amount, l.account_id, d.exchange_rate, -1, d.gl_journal_id, d.void_gl_journal_id
        FROM refund_receipt_lines l JOIN refund_receipts d ON d.id = l.refund_id
       WHERE d.organization_id = ${org}
    ),
    -- A document counts on its journal's date; a void takes it back on the void's date.
    moves AS (
      SELECT x.item_id, x.quantity, x.amount, x.account_id, x.exchange_rate, x.sign, j.journal_date
        FROM lines x JOIN gl_journals j ON j.id = x.gl_journal_id
      UNION ALL
      SELECT x.item_id, x.quantity, x.amount, x.account_id, x.exchange_rate, -x.sign, j.journal_date
        FROM lines x JOIN gl_journals j ON j.id = x.void_gl_journal_id
    )
    SELECT m.item_id, i.name, i.sku,
           SUM(m.sign * m.quantity)::text AS quantity,
           SUM(m.sign * ROUND(m.amount * m.exchange_rate, 4))::text AS amount
      FROM moves m
      JOIN accounts a ON a.id = m.account_id
      LEFT JOIN items i ON i.id = m.item_id AND i.organization_id = ${org}
     WHERE m.journal_date BETWEEN ${from}::date AND ${to}::date
       AND a.subcategory IN ${REVENUE}
     GROUP BY 1, 2, 3
  `);
  const parsed = rows.map((r) => ({ ...r, qty: money(r.quantity), amt: money(r.amount) })).filter((r) => !r.qty.isZero() || !r.amt.isZero());
  const total = sumMoney(parsed.map((r) => r.amt));
  const line = (label: string, code: string | undefined, qty: Decimal, amt: Decimal): ReportRow => ({
    kind: "account",
    label,
    code,
    values: [qty.toDecimalPlaces(4).toString(), fmt2(amt), share(amt, total), qty.isZero() ? null : fmt2(amt.div(qty))],
  });
  const out: ReportRow[] = parsed
    .filter((r) => r.item_id)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
    .map((r) => line(r.name ?? "Removed item", r.sku ?? undefined, r.qty, r.amt));
  const loose = parsed.filter((r) => !r.item_id);
  if (loose.length > 0) out.push(line("No item", undefined, sumMoney(loose.map((r) => r.qty)), sumMoney(loose.map((r) => r.amt))));
  out.push({ kind: "total", label: "Total", values: [null, fmt2(total), total.isZero() ? null : "100.0%", null] });
  return {
    title: "Sales by Product/Service",
    subtitle: rangeLabel(from, to),
    labelColumn: "Product/Service",
    columns: ["Quantity", "Amount", "% of sales", "Avg price"],
    columnKinds: ["number", "money", "number", "money"],
    rows: out,
    notes: ["Income lines on invoices and sales receipts, less credit memos and refunds, before sales tax. Income posted without a sales document (journal entries, deposits) shows on Sales by Customer only."],
  };
}

const DOC_LABEL: Record<AgingDocument["kind"], string> = {
  invoice: "Invoice",
  bill: "Bill",
  credit_memo: "Unused credit memo",
  payment: "Unapplied payment",
  vendor_credit: "Unused vendor credit",
};

const DOC_HREF: Record<AgingDocument["kind"], string> = {
  invoice: "/ar/invoices",
  bill: "/ap/bills",
  credit_memo: "/ar/credit-memos",
  payment: "/ar/payments",
  vendor_credit: "/ap/vendor-credits",
};

const day = (d: string) => format(parseISO(d), "MMM d, yyyy");

/** Every open document, grouped by customer or vendor. Credits print negative, without a due date. */
function openTable(r: AgingReport, title: string, labelColumn: string): ReportTable {
  const rows: ReportRow[] = [];
  for (const p of r.parties) {
    rows.push({ kind: "section", label: p.partyName, values: [null, null, null, null, null] });
    for (const d of p.documents) {
      const owed = d.kind === "invoice" || d.kind === "bill";
      rows.push({
        kind: "account",
        label: `${DOC_LABEL[d.kind]} ${d.number}`,
        href: `${DOC_HREF[d.kind]}/${d.id}`,
        depth: 1,
        values: [d.date, owed ? d.dueDate : null, owed ? String(d.daysPastDue) : null, owed ? fmt2(money(d.total)) : null, fmt2(money(d.openBalance))],
      });
    }
    rows.push({ kind: "subtotal", label: `Total ${p.partyName}`, values: [null, null, null, null, fmt2(money(p.buckets.total))] });
  }
  rows.push({ kind: "total", label: "Total", values: [null, null, null, null, fmt2(money(r.totals.total))] });
  return {
    title,
    subtitle: `As of ${day(r.asOf)}`,
    labelColumn,
    columns: ["Date", "Due date", "Days past due", "Amount", "Open balance"],
    columnKinds: ["number", "number", "number", "money", "money"],
    rows,
  };
}

export async function openInvoices(ctx: Ctx, input: z.input<typeof OpenDocumentsSchema> = {}): Promise<ReportTable> {
  return openTable(await arAging(ctx, input), "Open Invoices", "Customer");
}

export async function unpaidBills(ctx: Ctx, input: z.input<typeof OpenDocumentsSchema> = {}): Promise<ReportTable> {
  return openTable(await apAging(ctx, input), "Unpaid Bills", "Vendor");
}

const AUDIT_TRAIL_LIMIT = 5000;

/** The company's audit log for a date range (UTC), oldest first. */
export async function auditTrail(ctx: Ctx, input: z.input<typeof AuditTrailSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "read the audit trail");
  const f = AuditTrailSchema.parse(input);
  const { from, to } = range(f);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
  const events = await ctx.tx
    .select({
      occurredAt: auditLog.occurredAt,
      event: auditLog.event,
      actorType: auditLog.actorType,
      channel: auditLog.channel,
      metadata: auditLog.metadata,
      email: profiles.email,
      agentName: agents.name,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.id, auditLog.actorId))
    .leftJoin(agents, and(eq(agents.id, auditLog.agentId), eq(agents.organizationId, auditLog.organizationId)))
    .where(
      and(
        eq(auditLog.organizationId, ctx.actor.organizationId),
        gte(auditLog.occurredAt, new Date(`${from}T00:00:00Z`)),
        lt(auditLog.occurredAt, end),
        f.actorType ? eq(auditLog.actorType, f.actorType) : undefined,
        f.agentId ? eq(auditLog.agentId, f.agentId) : undefined
      )
    )
    .orderBy(asc(auditLog.occurredAt), asc(auditLog.id))
    .limit(AUDIT_TRAIL_LIMIT + 1);
  const rows: ReportRow[] = events.slice(0, AUDIT_TRAIL_LIMIT).map((e) => {
    const ref = auditRef(e.metadata);
    const who = e.agentName ? `${e.agentName} (agent)` : (e.email ?? (e.actorType === "system" ? "System" : "Unknown"));
    return {
      kind: "account",
      label: `${e.event}${ref ? ` · ${ref}` : ""}`,
      values: [e.occurredAt.toISOString().slice(0, 19).replace("T", " "), `${who}${e.channel ? ` via ${e.channel}` : ""}`],
    };
  });
  const notes = ["Times are UTC."];
  if (events.length > AUDIT_TRAIL_LIMIT) notes.push(`Showing the first ${AUDIT_TRAIL_LIMIT.toLocaleString("en-US")} events. Narrow the dates to see the rest.`);
  return {
    title: "Audit Trail",
    subtitle: rangeLabel(from, to),
    labelColumn: "Event",
    columns: ["Time (UTC)", "Who"],
    columnKinds: ["text", "text"],
    rows,
    notes,
  };
}
