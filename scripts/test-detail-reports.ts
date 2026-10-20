/**
 * End-to-end: detail reports. Sales by customer and expenses by vendor tie
 * to the P&L; sales by item counts quantities and takes voids back on the
 * void's date; open invoices and unpaid bills list the documents behind the
 * agings; the audit trail reads the company's log by UTC day and caps long
 * ranges. Every one exports as CSV and PDF.
 *
 *   npx tsx scripts/test-detail-reports.ts
 */
import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, sourceCodes } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as bills from "../src/lib/ap/bills";
import * as vendorCreditsSvc from "../src/lib/ap/vendor-credits";
import * as memos from "../src/lib/ar/credit-memos";
import * as invoices from "../src/lib/ar/invoices";
import * as itemsSvc from "../src/lib/ar/items";
import * as payments from "../src/lib/ar/payments";
import * as refunds from "../src/lib/ar/refunds";
import * as receipts from "../src/lib/ar/sales-receipts";
import * as txns from "../src/lib/banking/transactions";
import { createAndPostJournal, type JournalLineInput } from "../src/lib/gl/posting";
import { money, sumMoney } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import { apAging, arAging } from "../src/lib/reports/aging";
import * as detail from "../src/lib/reports/detail";
import { exportReport } from "../src/lib/reports/exports";
import { profitAndLossTable } from "../src/lib/reports/statements";
import { cellText, type ReportTable } from "../src/lib/reports/table";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

/** The values of the first row with this label. */
function row(t: ReportTable, label: string) {
  const r = t.rows.find((x) => x.label === label);
  if (!r) throw new Error(`no row "${label}" in ${t.title}: ${t.rows.map((x) => x.label).join(" | ")}`);
  return r.values;
}

async function main() {
  const t = await createTestOrg("detail-rpt-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const checking = account(t, "1010");
  const salesAcct = account(t, "4000");
  const services = account(t, "4100");
  const materials = account(t, "5100");
  const contractors = account(t, "6150");
  const dues = account(t, "6200");
  const rent = account(t, "6600");
  const [gj] = await db.select().from(sourceCodes).where(and(eq(sourceCodes.organizationId, t.org.id), eq(sourceCodes.code, "GJ")));
  const journal = async (journalDate: string, lines: JournalLineInput[]) => {
    const r = await createAndPostJournal({ organizationId: t.org.id, actorId: null, journalDate, sourceCodeId: gj.id, source: "manual", description: "Manual", lines });
    if (!r.ok) throw new Error(`post failed: ${r.code} ${r.error}`);
  };

  const widget = await run(owner, (ctx) => itemsSvc.createItem(ctx, { name: "Widget", sku: "W-1", type: "non_inventory", salesPrice: "100", incomeAccountId: salesAcct.id, taxable: false }));
  const consulting = await run(owner, (ctx) => itemsSvc.createItem(ctx, { name: "Consulting", salesPrice: "50", incomeAccountId: services.id, taxable: false }));
  const acme = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Acme Retail" }));
  const bolt = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Bolt Supply" }));
  const cora = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Cora Cafe" }));
  const ace = await run(owner, (ctx) => parties.createVendor(ctx, { name: "Ace Contracting" }));
  const lumber = await run(owner, (ctx) => parties.createVendor(ctx, { name: "Lumber Yard" }));

  const q2 = { from: "2026-04-01", to: "2026-06-30" };
  let voided!: invoices.InvoiceDetail;
  let boltInvoice!: invoices.InvoiceDetail;
  let aceBill!: Awaited<ReturnType<typeof bills.postBill>>;

  section("Setup");
  await check("Q2 sales: invoices, a walk-in receipt, a credit memo, a refund, a discount, a voided invoice, a journal entry", async () => {
    const inv1 = await run(owner, (ctx) =>
      invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-04-01", lines: [{ itemId: widget.id, quantity: "3" }, { itemId: consulting.id, quantity: "2" }], post: true })
    );
    assertEq(money(inv1.totalAmount).toFixed(2), "400.00", "inv1 total");
    await run(owner, (ctx) => receipts.createSalesReceipt(ctx, { receiptDate: "2026-04-05", method: "cash", lines: [{ itemId: widget.id }], post: true }));
    boltInvoice = await run(owner, (ctx) =>
      invoices.createInvoice(ctx, { customerId: bolt.id, invoiceDate: "2026-04-10", lines: [{ description: "Custom work", unitPrice: "200", accountId: services.id }], post: true })
    );
    await run(owner, (ctx) => memos.createCreditMemo(ctx, { customerId: bolt.id, memoDate: "2026-04-12", lines: [{ itemId: widget.id }], post: true }));
    await run(owner, (ctx) =>
      refunds.createRefund(ctx, { kind: "items", customerId: acme.id, refundDate: "2026-04-15", method: "check", reference: "3001", bankAccountId: checking.id, lines: [{ itemId: consulting.id }], post: true })
    );
    voided = await run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-04-20", lines: [{ itemId: widget.id }], post: true }));
    await run(owner, (ctx) => invoices.voidInvoice(ctx, { id: voided.id, reason: "sent twice" }));
    await run(owner, (ctx) =>
      payments.createCustomerPayment(ctx, { customerId: acme.id, paymentDate: "2026-05-01", method: "ach", applications: [{ invoiceId: inv1.id, amount: "390", discountAmount: "10" }], post: true })
    );
    await run(owner, (ctx) => payments.createCustomerPayment(ctx, { customerId: cora.id, paymentDate: "2026-05-02", method: "check", amount: "25", post: true }));
    await journal("2026-05-15", [
      { accountId: checking.id, debit: "75" },
      { accountId: services.id, credit: "75" },
    ]);
  });
  await check("Q2 spending: a bill, a vendor credit, a vendor expense, an expense without a vendor, a journal entry", async () => {
    aceBill = await run(owner, async (ctx) => {
      const b = await bills.createBill(ctx, { vendorId: ace.id, billDate: "2026-04-02", lines: [{ accountId: contractors.id, amount: "1000" }, { accountId: rent.id, amount: "500" }], submit: true });
      await bills.approveBill(ctx, { id: b.id });
      return bills.postBill(ctx, { id: b.id });
    });
    await run(owner, (ctx) => vendorCreditsSvc.createVendorCredit(ctx, { vendorId: ace.id, creditDate: "2026-04-03", lines: [{ accountId: contractors.id, amount: "200" }], post: true }));
    await run(owner, (ctx) =>
      txns.createExpense(ctx, { type: "expense", txnDate: "2026-04-04", bankAccountId: checking.id, vendorId: lumber.id, method: "ach", lines: [{ accountId: materials.id, amount: "300" }], post: true })
    );
    await run(owner, (ctx) => txns.createExpense(ctx, { type: "expense", txnDate: "2026-04-05", bankAccountId: checking.id, method: "ach", lines: [{ accountId: dues.id, amount: "40" }], post: true }));
    await journal("2026-05-20", [
      { accountId: rent.id, debit: "60" },
      { accountId: checking.id, credit: "60" },
    ]);
  });

  section("Sales by customer");
  await check("Acme 440, Bolt 100, no customer 175: the total matches revenue on the P&L", async () => {
    const r = await run(viewer, (ctx) => detail.salesByCustomer(ctx, q2));
    assertEq(row(r, "Acme Retail")[0], "440.00", "Acme: 400 + 100 voided later − 50 refund − 10 discount");
    assertEq(row(r, "Bolt Supply")[0], "100.00", "Bolt: 200 − 100 credit memo");
    assertEq(row(r, "No customer")[0], "175.00", "walk-in receipt 100 + journal 75");
    assertEq(row(r, "Total").join(","), "715.00,100.0%", "total");
    assert(!r.rows.some((x) => x.label === "Cora Cafe"), "a payment alone isn't a sale");
    const pnl = await run(viewer, (ctx) => profitAndLossTable(ctx, q2));
    assertEq(row(pnl, "Total Operating Revenue")[0], "715.00", "P&L revenue");
  });
  await check("the void lands on the void's date: over the whole year Acme drops to 340", async () => {
    const r = await run(viewer, (ctx) => detail.salesByCustomer(ctx, { from: "2026-01-01", to: "2099-12-31" }));
    assertEq(row(r, "Acme Retail")[0], "340.00", "voided invoice taken back");
  });

  section("Sales by item");
  await check("Widget 4 for 400, Consulting 1 for 50, no item 1 for 200", async () => {
    const r = await run(viewer, (ctx) => detail.salesByItem(ctx, q2));
    const w = r.rows.find((x) => x.label === "Widget");
    assertEq(w?.code, "W-1", "sku as the code");
    assertEq(w?.values.join(","), "4,400.00,61.5%,100.00", "3 invoiced + 1 receipt − 1 credited + 1 voided later");
    assertEq(row(r, "Consulting").join(","), "1,50.00,7.7%,50.00", "2 invoiced − 1 refunded");
    assertEq(row(r, "No item").join(","), "1,200.00,30.8%,200.00", "custom work");
    assertEq(row(r, "Total")[1], "650.00", "sales documents only: 715 − 75 journal + 10 discount");
    assertEq(cellText(r, 0, "2.25"), "2.25", "quantities never print as money");
    assertEq(cellText(r, 1, "2.25"), "$2.25", "amounts do");
  });
  await check("over the whole year the voided widget is taken back", async () => {
    const r = await run(viewer, (ctx) => detail.salesByItem(ctx, { from: "2026-01-01", to: "2099-12-31" }));
    assertEq(row(r, "Widget").slice(0, 2).join(","), "3,300.00", "widget");
  });

  section("Expenses by vendor");
  await check("Ace 1300, Lumber 300, no vendor 100: the total matches COGS plus expenses", async () => {
    const r = await run(viewer, (ctx) => detail.expensesByVendor(ctx, q2));
    assertEq(row(r, "Ace Contracting")[0], "1300.00", "bill 1500 − credit 200");
    assertEq(row(r, "Lumber Yard")[0], "300.00", "expense");
    assertEq(row(r, "No vendor")[0], "100.00", "dues 40 + journal 60");
    assertEq(row(r, "Total")[0], "1700.00", "total");
    const pnl = await run(viewer, (ctx) => profitAndLossTable(ctx, q2));
    const cogs = money(row(pnl, "Total COGS")[0] ?? 0);
    const opex = money(row(pnl, "Total Operating Expenses")[0] ?? 0);
    assertEq(cogs.plus(opex).toFixed(2), "1700.00", "P&L COGS + expenses");
  });

  section("Open invoices and unpaid bills");
  await check("open invoices: Bolt's invoice with 100 left, Cora's unapplied payment; totals match the AR aging", async () => {
    const r = await run(viewer, (ctx) => detail.openInvoices(ctx, { asOf: "2026-06-30" }));
    const inv = r.rows.find((x) => x.label === `Invoice ${boltInvoice.invoiceNumber}`);
    assert(inv, "Bolt's invoice listed");
    assertEq(inv.href, `/ar/invoices/${boltInvoice.id}`, "links to the invoice");
    assertEq(inv.values[0], "2026-04-10", "date");
    assertEq(inv.values.slice(3).join(","), "200.00,100.00", "amount and open balance");
    assertEq(row(r, "Total Bolt Supply")[4], "100.00", "Bolt subtotal");
    const pay = r.rows.find((x) => x.label.startsWith("Unapplied payment"));
    assertEq(pay?.values.join(","), "2026-05-02,,,,-25.00", "credit: no due date, days, or amount");
    assert(!r.rows.some((x) => x.label === `Invoice ${voided.invoiceNumber}`), "voided invoice left out");
    const aging = await run(viewer, (ctx) => arAging(ctx, { asOf: "2026-06-30" }));
    assertEq(row(r, "Total")[4], money(aging.totals.total).toFixed(2), "matches the aging");
    assertEq(r.subtitle, "As of Jun 30, 2026", "subtitle");
  });
  await check("unpaid bills: Ace owes 1300 net of the credit; totals match the AP aging", async () => {
    const r = await run(viewer, (ctx) => detail.unpaidBills(ctx, { asOf: "2026-06-30" }));
    assertEq(row(r, "Total Ace Contracting")[4], "1300.00", "Ace");
    const bill = r.rows.find((x) => x.href === `/ap/bills/${aceBill.id}`);
    assert(bill, "the bill links to itself");
    assertEq(bill.values[3], "1500.00", "bill amount");
    const aging = await run(viewer, (ctx) => apAging(ctx, { asOf: "2026-06-30" }));
    assertEq(row(r, "Total")[4], money(aging.totals.total).toFixed(2), "matches the aging");
  });

  section("Audit trail");
  const utcToday = new Date().toISOString().slice(0, 10);
  await check("today's events, oldest first, with who and how", async () => {
    const r = await run(viewer, (ctx) => detail.auditTrail(ctx, { from: utcToday, to: utcToday }));
    const events = await db.select().from(auditLog).where(eq(auditLog.organizationId, t.org.id));
    assertEq(r.rows.length, events.filter((e) => e.occurredAt.toISOString().slice(0, 10) === utcToday).length, "every event today");
    const posted = r.rows.find((x) => x.label === `ar.invoice.posted · ${boltInvoice.invoiceNumber}`);
    assert(posted, "invoice posting listed with its number");
    assert(posted.values[1]?.includes(" via "), `who and channel: ${posted.values[1]}`);
    const times = r.rows.map((x) => x.values[0] ?? "");
    assert(times.every((v, i) => i === 0 || times[i - 1] <= v), "oldest first");
    assertEq(r.notes?.[0], "Times are UTC.", "UTC note");
  });
  await check("filter by who: no agent events here", async () => {
    const r = await run(viewer, (ctx) => detail.auditTrail(ctx, { from: utcToday, to: utcToday, actorType: "agent" }));
    assertEq(r.rows.length, 0, "agents did nothing");
    await expectError(() => run(viewer, (ctx) => detail.auditTrail(ctx, { from: utcToday, to: "2020-01-01" })), "invalid_input");
  });
  await check("more than 5,000 events: the first 5,000 and a note", async () => {
    const base = Date.parse("2020-03-01T00:00:00Z");
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      organizationId: t.org.id,
      actorType: "system" as const,
      event: "test.event",
      metadata: { name: `E${i}` },
      occurredAt: new Date(base + i * 1000),
    }));
    for (let i = 0; i < rows.length; i += 1000) await db.insert(auditLog).values(rows.slice(i, i + 1000));
    const r = await run(viewer, (ctx) => detail.auditTrail(ctx, { from: "2020-03-01", to: "2020-03-01" }));
    assertEq(r.rows.length, 5000, "capped");
    assertEq(r.rows[0].label, "test.event · E0", "oldest first");
    assertEq(r.rows[0].values.join(","), "2020-03-01 00:00:00,System", "time and who");
    assert(r.notes?.some((n) => n.startsWith("Showing the first 5,000 events")), "note");
    const none = await run(viewer, (ctx) => detail.auditTrail(ctx, { from: "2020-03-02", to: "2020-03-02" }));
    assertEq(none.rows.length, 0, "the next UTC day is empty");
  });

  section("Exports");
  await check("each report exports as CSV and PDF", async () => {
    const reports = ["sales-by-customer", "sales-by-item", "expenses-by-vendor", "open-invoices", "unpaid-bills", "audit-trail"] as const;
    for (const report of reports) {
      const csv = await run(viewer, (ctx) => exportReport(ctx, { report, format: "csv", ...q2, asOf: "2026-06-30" }));
      assert(csv.contentType.startsWith("text/csv") && csv.bytes.length > 20, `${report} CSV`);
      const pdf = await run(viewer, (ctx) => exportReport(ctx, { report, format: "pdf", ...q2, asOf: "2026-06-30" }));
      assertEq(pdf.bytes.subarray(0, 5).toString(), "%PDF-", `${report} PDF`);
    }
    const items = (await run(viewer, (ctx) => exportReport(ctx, { report: "sales-by-item", ...q2 }))).bytes.toString();
    assert(items.includes("W-1 Widget,4,400.00,61.5%,100.00"), items);
    const opened = (await run(viewer, (ctx) => exportReport(ctx, { report: "open-invoices", asOf: "2026-06-30" }))).bytes.toString();
    assert(opened.includes(`Invoice ${boltInvoice.invoiceNumber},2026-04-10`), opened);
    const exportsLogged = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, t.org.id), eq(auditLog.event, "reports.exported")));
    assertEq(exportsLogged.length, reports.length * 2 + 2, "every export audited");
  });
  await check("rows add up to the total", async () => {
    const r = await run(viewer, (ctx) => detail.salesByCustomer(ctx, q2));
    const sum = sumMoney(r.rows.filter((x) => x.kind === "account").map((x) => x.values[0] ?? 0));
    assertEq(sum.toFixed(2), row(r, "Total")[0], "rows add to the total");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
