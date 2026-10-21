import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { FORM_1099_BOXES, form1099Report } from "@/lib/ap/form-1099";
import { changesAfterClose } from "@/lib/gl/close";
import { notFound } from "@/lib/errors";
import { money } from "@/lib/money";
import { reportPdf } from "@/lib/pdf/documents";
import { amount, flag, id, isoDate } from "@/lib/schemas";
import { apAging, arAging, type AgingReport } from "./aging";
import { auditTrail, AuditTrailSchema, expensesByVendor, openInvoices, salesByCustomer, salesByItem, unpaidBills } from "./detail";
import { inventoryValuation, stockStatus, valuationDetail } from "@/lib/inventory/stock";
import { accountLedger, balanceSheet, trialBalance } from "./financial";
import { budgetVsActual, cashFlow, profitAndLossByDimension, profitAndLossByPeriod, profitAndLossTable } from "./statements";
import { fmt2, reportCsv, reportFileName, type ReportRow, type ReportTable } from "./table";

/**
 * Every report as a table, and every table as a CSV or PDF file. The screen,
 * the API, and the downloads all come from here, so they can't disagree.
 * Downloads are audited: a report leaving the app is worth a record.
 */

export const REPORT_KEYS = [
  "profit-and-loss",
  "profit-and-loss-by-period",
  "profit-and-loss-by-class",
  "budget-vs-actual",
  "cash-flow",
  "balance-sheet",
  "trial-balance",
  "ar-aging",
  "ap-aging",
  "account-ledger",
  "1099",
  "sales-by-customer",
  "sales-by-item",
  "inventory-valuation",
  "inventory-valuation-detail",
  "inventory-stock-status",
  "expenses-by-vendor",
  "open-invoices",
  "unpaid-bills",
  "audit-trail",
  "changes-after-close",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const ReportParamsSchema = z.object({
  report: z.enum(REPORT_KEYS).default("profit-and-loss").describe("Which report."),
  from: isoDate.optional(),
  to: isoDate.optional(),
  asOf: isoDate.optional().describe("Balance sheet, trial balance, agings, open invoices, unpaid bills, and inventory valuation."),
  period: z.enum(["month", "quarter", "year"]).optional().describe("profit-and-loss-by-period columns."),
  dimensionId: id.optional().describe("profit-and-loss-by-class: the class or location dimension."),
  budgetId: id.optional().describe("budget-vs-actual: the budget."),
  accountId: id.optional().describe("account-ledger: the account."),
  itemId: id.optional().describe("inventory-valuation-detail: one item."),
  year: z.coerce.number().int().min(2000).max(2100).optional().describe("1099: the tax year."),
  threshold: amount.optional().describe("1099: the reporting threshold."),
  includeZero: flag.optional().describe("trial-balance: include accounts with no activity."),
  actorType: AuditTrailSchema.shape.actorType,
  agentId: AuditTrailSchema.shape.agentId,
});
export type ReportParams = z.input<typeof ReportParamsSchema>;

export const ExportReportSchema = ReportParamsSchema.extend({
  format: z.enum(["csv", "pdf"]).default("csv"),
});

function agingTable(r: AgingReport, title: string, partyLabel: string): ReportTable {
  const cols = ["current", "days1to30", "days31to60", "days61to90", "over90", "total"] as const;
  const rows: ReportRow[] = r.parties.map((p) => ({ kind: "account", label: p.partyName, values: cols.map((c) => fmt2(money(p.buckets[c]))) }));
  rows.push({ kind: "total", label: "Total", values: cols.map((c) => fmt2(money(r.totals[c]))) });
  return { title, subtitle: `As of ${r.asOf}`, labelColumn: partyLabel, columns: ["Current", "1-30", "31-60", "61-90", "Over 90", "Total"], rows };
}

async function balanceSheetTable(ctx: Ctx, asOf?: string): Promise<ReportTable> {
  const b = await balanceSheet(ctx, { asOf });
  const rows: ReportRow[] = [];
  for (const section of [b.assets, b.liabilities, b.equity]) {
    rows.push({ kind: "section", label: section.label, values: [null] });
    for (const g of section.subgroups) {
      rows.push({ kind: "section", label: g.label, depth: 1, values: [null] });
      for (const r of g.rows) {
        rows.push({ kind: "account", label: r.name, code: r.code === "—" ? undefined : r.code, accountId: r.accountId.startsWith("__") ? undefined : r.accountId, depth: 2, values: [fmt2(r.displayAmount)] });
      }
      rows.push({ kind: "subtotal", label: `Total ${g.label}`, depth: 1, values: [fmt2(g.subtotal)] });
    }
    rows.push({ kind: "total", label: `Total ${section.label}`, values: [fmt2(section.total)] });
  }
  rows.push({ kind: "total", label: "Total Liabilities and Equity", values: [fmt2(b.liabilities.total.plus(b.equity.total))] });
  return {
    title: "Balance Sheet",
    subtitle: `As of ${b.asOfDate}`,
    labelColumn: "Account",
    columns: ["Amount"],
    rows,
    notes: b.outOfBalance.isZero() ? undefined : [`Out of balance by ${fmt2(b.outOfBalance)}.`],
  };
}

async function trialBalanceTable(ctx: Ctx, asOf?: string, includeZero?: boolean): Promise<ReportTable> {
  const tb = await trialBalance(ctx, { asOf, includeZero });
  let debit = money(0);
  let credit = money(0);
  const rows: ReportRow[] = tb.rows.map((r) => {
    const d = r.netDebit.gt(0) ? r.netDebit : null;
    const c = r.netDebit.lt(0) ? r.netDebit.neg() : null;
    if (d) debit = debit.plus(d);
    if (c) credit = credit.plus(c);
    return { kind: "account", label: r.name, code: r.code, accountId: r.accountId, values: [d ? fmt2(d) : null, c ? fmt2(c) : null] };
  });
  rows.push({ kind: "total", label: "Total", values: [fmt2(debit), fmt2(credit)] });
  return { title: "Trial Balance", subtitle: `As of ${tb.asOf}`, labelColumn: "Account", columns: ["Debit", "Credit"], rows };
}

async function accountLedgerTable(ctx: Ctx, p: z.output<typeof ReportParamsSchema>): Promise<ReportTable> {
  if (!p.accountId) throw notFound("Account");
  const [a] = await ctx.tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, p.accountId), eq(accounts.organizationId, ctx.actor.organizationId)));
  if (!a) throw notFound("Account");
  const g = await accountLedger(ctx, { accountId: a.id, from: p.from, to: p.to });
  const sign = (v: ReturnType<typeof money>) => (a.normalBalance === "debit" ? v : v.neg());
  const rows: ReportRow[] = [{ kind: "account", label: "Opening balance", values: [null, null, null, null, fmt2(sign(g.opening))] }];
  for (const r of g.rows) {
    rows.push({
      kind: "account",
      label: r.journalDate,
      values: [r.journalNumber, r.memo ?? r.description, r.debit.isZero() ? null : fmt2(r.debit), r.credit.isZero() ? null : fmt2(r.credit), fmt2(sign(r.runningBalance))],
    });
  }
  const closing = g.rows.length ? g.rows[g.rows.length - 1].runningBalance : g.opening;
  rows.push({ kind: "total", label: "Closing balance", values: [null, null, null, null, fmt2(sign(closing))] });
  return {
    title: `Account Ledger: ${a.code} ${a.name}`,
    subtitle: `${p.from ?? "Start"} to ${p.to ?? "today"}`,
    labelColumn: "Date",
    columns: ["Number", "Description", "Debit", "Credit", "Balance"],
    rows,
  };
}

async function form1099Table(ctx: Ctx, p: z.output<typeof ReportParamsSchema>): Promise<ReportTable> {
  const r = await form1099Report(ctx, { year: p.year, threshold: p.threshold, reportableOnly: true });
  const rows: ReportRow[] = r.vendors.map((v) => ({
    kind: "account",
    label: `${v.name}${v.tinLast4 ? ` (TIN •••${v.tinLast4})` : ""}`,
    values: [...FORM_1099_BOXES.map((b) => fmt2(money(v.boxes[b]))), fmt2(money(v.total))],
  }));
  rows.push({ kind: "total", label: "Total", values: [...FORM_1099_BOXES.map((b) => fmt2(money(r.totals[b]))), fmt2(FORM_1099_BOXES.reduce((acc, b) => acc.plus(money(r.totals[b])), money(0)))] });
  return {
    title: "1099 Summary",
    subtitle: `Tax year ${r.year} · threshold ${fmt2(money(r.threshold))}`,
    labelColumn: "Vendor",
    columns: ["NEC 1", "MISC 1", "MISC 2", "MISC 3", "MISC 6", "MISC 10", "Total"],
    rows,
    notes: ["Taxpayer ids show their last 4 digits. The CSV export on the 1099 page has the full numbers for filing."],
  };
}

/** Any report as a table. */
export async function reportTable(ctx: Ctx, input: ReportParams): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run reports");
  const p = ReportParamsSchema.parse(input);
  switch (p.report) {
    case "profit-and-loss":
      return profitAndLossTable(ctx, p);
    case "profit-and-loss-by-period":
      return profitAndLossByPeriod(ctx, p);
    case "profit-and-loss-by-class":
      return profitAndLossByDimension(ctx, p);
    case "budget-vs-actual":
      return budgetVsActual(ctx, p);
    case "cash-flow":
      return cashFlow(ctx, p);
    case "balance-sheet":
      return balanceSheetTable(ctx, p.asOf);
    case "trial-balance":
      return trialBalanceTable(ctx, p.asOf, p.includeZero);
    case "ar-aging":
      return agingTable(await arAging(ctx, { asOf: p.asOf }), "AR Aging Summary", "Customer");
    case "ap-aging":
      return agingTable(await apAging(ctx, { asOf: p.asOf }), "AP Aging Summary", "Vendor");
    case "account-ledger":
      return accountLedgerTable(ctx, p);
    case "1099":
      return form1099Table(ctx, p);
    case "sales-by-customer":
      return salesByCustomer(ctx, p);
    case "sales-by-item":
      return salesByItem(ctx, p);
    case "inventory-valuation":
      return inventoryValuation(ctx, p);
    case "inventory-valuation-detail":
      return valuationDetail(ctx, p);
    case "inventory-stock-status":
      return stockStatus(ctx);
    case "expenses-by-vendor":
      return expensesByVendor(ctx, p);
    case "open-invoices":
      return openInvoices(ctx, p);
    case "unpaid-bills":
      return unpaidBills(ctx, p);
    case "audit-trail":
      return auditTrail(ctx, p);
    case "changes-after-close":
      return changesAfterClose(ctx, p);
  }
}

export type ReportFile = { fileName: string; contentType: string; bytes: Buffer };

/** A report as a CSV or PDF file. Audited. */
export async function exportReport(ctx: Ctx, input: z.input<typeof ExportReportSchema>): Promise<ReportFile> {
  const p = ExportReportSchema.parse(input);
  const table = await reportTable(ctx, p);
  const file =
    p.format === "pdf"
      ? await reportPdf(ctx, table)
      : { fileName: reportFileName(table, "csv"), contentType: "text/csv; charset=utf-8", bytes: Buffer.from(reportCsv(table), "utf8") };
  const { format: fileFormat, report, ...params } = p;
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "reports.exported",
      entityType: "report",
      metadata: { report, format: fileFormat, params, rows: table.rows.length },
    },
    ctx.tx
  );
  return file;
}
