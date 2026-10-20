/**
 * End-to-end: financial statements as report tables. P&L by month and
 * quarter (ties to the income statement), by class, budget vs actual, the
 * statement of cash flows (ties to the change in cash), the balance sheet
 * and trial balance tables, and CSV / PDF exports of every report (audited).
 *
 *   npx tsx scripts/test-statements.ts
 */
import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, dimensions, dimensionValues, fiscalPeriods, fiscalYears, sourceCodes } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import { createBudget, setBudgetEntry } from "../src/lib/gl/budgets";
import { createAndPostJournal, type JournalLineInput } from "../src/lib/gl/posting";
import { getIncomeStatement } from "../src/lib/gl/reports";
import { money } from "../src/lib/money";
import { exportReport, REPORT_KEYS, reportTable } from "../src/lib/reports/exports";
import * as st from "../src/lib/reports/statements";
import type { ReportTable } from "../src/lib/reports/table";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

/** The values of the first row with this label. */
function row(t: ReportTable, label: string, kind?: string) {
  const r = t.rows.find((x) => x.label === label && (!kind || x.kind === kind));
  if (!r) throw new Error(`no row "${label}" in ${t.title}: ${t.rows.map((x) => x.label).join(" | ")}`);
  return r.values;
}

async function main() {
  const t = await createTestOrg("stmt-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const viewer = t.as("viewer");
  const owner = t.as("owner");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const cash = account(t, "1010");
  const accrued = account(t, "1400"); // other current asset (manual journals can't touch AR)
  const equipment = account(t, "1500");
  const accruedExp = account(t, "2220"); // accrued liability (manual journals can't touch AP)
  const loan = account(t, "2500");
  const sales = account(t, "4100");
  const fees = account(t, "6100");
  const rent = account(t, "6600");
  const [gj] = await db.select().from(sourceCodes).where(and(eq(sourceCodes.organizationId, t.org.id), eq(sourceCodes.code, "GJ")));
  const [classDim] = await db.select().from(dimensions).where(and(eq(dimensions.organizationId, t.org.id), eq(dimensions.code, "CLASS")));
  const [retail, wholesale] = await db
    .insert(dimensionValues)
    .values([
      { organizationId: t.org.id, dimensionId: classDim.id, code: "RET", name: "Retail" },
      { organizationId: t.org.id, dimensionId: classDim.id, code: "WHL", name: "Wholesale" },
    ])
    .returning();

  const post = async (journalDate: string, description: string, lines: JournalLineInput[]) => {
    const r = await createAndPostJournal({ organizationId: t.org.id, actorId: null, journalDate, sourceCodeId: gj.id, source: "manual", description, lines });
    if (!r.ok) throw new Error(`post failed: ${r.code} ${r.error}`);
  };
  const tag = (valueId: string) => [{ dimensionId: classDim.id, valueId }];

  section("Setup");
  await check("post Q1: sales, rent, a loan, equipment, an unpaid fee", async () => {
    await post("2026-01-10", "Retail sales", [
      { accountId: cash.id, debit: "1000" },
      { accountId: sales.id, credit: "1000", dimensions: tag(retail.id) },
    ]);
    await post("2026-01-15", "Rent", [
      { accountId: rent.id, debit: "300", dimensions: tag(wholesale.id) },
      { accountId: cash.id, credit: "300" },
    ]);
    await post("2026-02-05", "Accrued revenue, no class", [
      { accountId: accrued.id, debit: "500" },
      { accountId: sales.id, credit: "500" },
    ]);
    await post("2026-02-10", "Loan", [
      { accountId: cash.id, debit: "5000" },
      { accountId: loan.id, credit: "5000" },
    ]);
    await post("2026-02-20", "Equipment", [
      { accountId: equipment.id, debit: "2000" },
      { accountId: cash.id, credit: "2000" },
    ]);
    await post("2026-03-03", "Fee on account", [
      { accountId: fees.id, debit: "200" },
      { accountId: accruedExp.id, credit: "200" },
    ]);
  });

  const q1 = { from: "2026-01-01", to: "2026-03-31" };

  section("Profit and loss");
  await check("by month: Jan 700, Feb 500, Mar -200, total 1000; ties to the income statement", async () => {
    const r = await run(viewer, (ctx) => st.profitAndLossByPeriod(ctx, { ...q1, period: "month" }));
    assertEq(r.columns.join(","), "Jan 2026,Feb 2026,Mar 2026,Total", "columns");
    assertEq(row(r, "Net Income").join(","), "700.00,500.00,-200.00,1000.00", "net income");
    assertEq(row(r, "Total Operating Revenue").join(","), "1000.00,500.00,0.00,1500.00", "revenue");
    const is = await getIncomeStatement(t.org.id, { fromDate: q1.from, toDate: q1.to });
    assertEq(is.netIncome.toFixed(2), "1000.00", "income statement agrees");
    const single = await run(viewer, (ctx) => st.profitAndLossTable(ctx, q1));
    assertEq(row(single, "Net Income")[0], "1000.00", "single column");
  });
  await check("by quarter: one Q1 column; more than 36 columns is refused", async () => {
    const r = await run(viewer, (ctx) => st.profitAndLossByPeriod(ctx, { ...q1, period: "quarter" }));
    assertEq(r.columns.join(","), "Q1 2026,Total", "columns");
    assertEq(row(r, "Net Income")[0], "1000.00", "Q1");
    await expectError(() => run(viewer, (ctx) => st.profitAndLossByPeriod(ctx, { from: "2020-01-01", to: "2026-03-31", period: "month" })), "invalid_input");
    await expectError(() => run(viewer, (ctx) => st.profitAndLossByPeriod(ctx, { from: "2026-03-01", to: "2026-01-01" })), "invalid_input");
  });
  await check("by class: Retail, Wholesale, and lines without a class", async () => {
    const r = await run(viewer, (ctx) => st.profitAndLossByDimension(ctx, { ...q1, dimensionId: classDim.id }));
    assertEq(r.columns.join(","), "Retail,Wholesale,No class,Total", "columns");
    assertEq(row(r, "Net Income").join(","), "1000.00,-300.00,300.00,1000.00", "net income per class");
  });
  await check("budget vs actual: 1000 against a budget of 800 is 200 over, 125.0%", async () => {
    const [fy] = await db.select().from(fiscalYears).where(eq(fiscalYears.organizationId, t.org.id));
    const [jan] = await db
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.organizationId, t.org.id), eq(fiscalPeriods.startDate, "2026-01-01")));
    const b = await createBudget({ organizationId: t.org.id, fiscalYearId: fy.id, code: "PLAN", name: "FY2026 Plan" });
    await setBudgetEntry({ organizationId: t.org.id, budgetId: b.id, accountId: sales.id, periodId: jan.id, amount: "800" });
    await setBudgetEntry({ organizationId: t.org.id, budgetId: b.id, accountId: rent.id, periodId: jan.id, amount: "300" });
    const r = await run(viewer, (ctx) => st.budgetVsActual(ctx, { from: "2026-01-01", to: "2026-01-31", budgetId: b.id }));
    const sale = r.rows.find((x) => x.accountId === sales.id)!.values;
    assertEq(sale.join(","), "1000.00,800.00,200.00,125.0%", "sales line");
    const rentRow = r.rows.find((x) => x.accountId === rent.id)!.values;
    assertEq(rentRow.join(","), "300.00,300.00,0.00,100.0%", "rent on budget");
    assertEq(row(r, "Net Income").join(","), "700.00,500.00,200.00,140.0%", "net income");
    await expectError(() => run(viewer, (ctx) => st.budgetVsActual(ctx, { budgetId: classDim.id })), "not_found");
  });

  section("Cash flow");
  await check("operating 700, investing -2000, financing 5000: 3700, matching the change in cash", async () => {
    const r = await run(viewer, (ctx) => st.cashFlow(ctx, q1));
    assertEq(row(r, "Net Income")[0], "1000.00", "net income");
    assertEq(r.rows.find((x) => x.accountId === accrued.id)?.values[0], "-500.00", "more current assets used cash");
    assertEq(r.rows.find((x) => x.accountId === accruedExp.id)?.values[0], "200.00", "more current liabilities kept cash");
    assertEq(row(r, "Net cash from operating activities")[0], "700.00", "operating");
    assertEq(row(r, "Net cash from investing activities")[0], "-2000.00", "investing");
    assertEq(row(r, "Net cash from financing activities")[0], "5000.00", "financing");
    assertEq(r.cash.netChange, "3700.00", "net change");
    assertEq(r.cash.beginning, "0.00", "beginning");
    assertEq(r.cash.ending, "3700.00", "ending");
    assert(r.cash.reconciles, "ties to the cash accounts");
    const feb = await run(viewer, (ctx) => st.cashFlow(ctx, { from: "2026-02-01", to: "2026-02-28" }));
    assertEq(feb.cash.beginning, "700.00", "February starts with January's cash");
  });

  section("Tables for the older reports");
  await check("balance sheet: assets equal liabilities and equity", async () => {
    const r = await run(viewer, (ctx) => reportTable(ctx, { report: "balance-sheet", asOf: "2026-03-31" }));
    const assets = money(row(r, "Total Assets")[0] ?? 0);
    assertEq(assets.toFixed(2), "6200.00", "assets: 3700 cash + 500 accrued + 2000 equipment");
    assertEq(row(r, "Total Liabilities and Equity")[0], assets.toFixed(2), "balances");
  });
  await check("trial balance: debits equal credits", async () => {
    const r = await run(viewer, (ctx) => reportTable(ctx, { report: "trial-balance", asOf: "2026-03-31" }));
    const [d, c] = row(r, "Total");
    assertEq(d, c, "balanced");
  });

  section("Exports");
  await check("every report exports as CSV; PDFs render; each export is audited", async () => {
    for (const report of REPORT_KEYS) {
      const f = await run(viewer, (ctx) => exportReport(ctx, { report, format: "csv", ...q1, accountId: cash.id, year: 2026 }));
      assert(f.contentType.startsWith("text/csv") && f.bytes.length > 20, `${report} CSV`);
    }
    const pdf = await run(viewer, (ctx) => exportReport(ctx, { report: "profit-and-loss-by-period", format: "pdf", ...q1 }));
    assertEq(pdf.bytes.subarray(0, 5).toString(), "%PDF-", "PDF");
    assert(pdf.fileName.endsWith(".pdf"), pdf.fileName);
    const csv = (await run(viewer, (ctx) => exportReport(ctx, { report: "profit-and-loss", ...q1 }))).bytes.toString();
    assert(csv.startsWith("Account,Total\r\nProfit and Loss"), csv.slice(0, 60));
    assert(csv.includes("4100 Sales") || csv.includes("4100 "), "account codes in the CSV");
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, t.org.id), eq(auditLog.event, "reports.exported")));
    assertEq(audits.length, REPORT_KEYS.length + 2, "one audit row per export");
  });
  await check("an account ledger for another company's account is not found", async () => {
    await expectError(() => run(owner, (ctx) => reportTable(ctx, { report: "account-ledger", accountId: classDim.id })), "not_found");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
