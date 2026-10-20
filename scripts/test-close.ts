/**
 * End-to-end: month-end close. The checklist (reconciliations, drafts,
 * holding accounts, AR / AP tie-out, the company's own items), closing
 * through a period (soft, then hard with the closing password), adjusting
 * entries and override posts, reopening, the changes after close report,
 * year end (computed retained earnings, the year closing with its last
 * period), and who may do what: people only, admins and owners.
 *
 *   npx tsx scripts/test-close.ts
 */
import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, fiscalPeriods, fiscalYears, reconciliations, sourceCodes } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as invoices from "../src/lib/ar/invoices";
import * as close from "../src/lib/gl/close";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import * as journals from "../src/lib/gl/journals";
import { createAndPostJournal, type JournalLineInput } from "../src/lib/gl/posting";
import * as parties from "../src/lib/parties/service";
import { exportReport, reportTable } from "../src/lib/reports/exports";
import { profitAndLossTable } from "../src/lib/reports/statements";
import type { ReportTable } from "../src/lib/reports/table";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

function row(t: ReportTable, label: string) {
  const r = t.rows.find((x) => x.label === label);
  if (!r) throw new Error(`no row "${label}" in ${t.title}: ${t.rows.map((x) => x.label).join(" | ")}`);
  return r.values;
}

async function main() {
  const t = await createTestOrg("close-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const agent: Actor = { ...t.as("admin"), kind: "agent", userId: null, agentId: crypto.randomUUID(), agentName: "Closer" };
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const cash = account(t, "1010");
  const sales = account(t, "4100");
  const rent = account(t, "6600");
  const uncategorized = account(t, "6900");
  const [gj] = await db.select().from(sourceCodes).where(and(eq(sourceCodes.organizationId, t.org.id), eq(sourceCodes.code, "GJ")));
  const post = async (journalDate: string, lines: JournalLineInput[]) => {
    const r = await createAndPostJournal({ organizationId: t.org.id, actorId: null, journalDate, sourceCodeId: gj.id, source: "manual", description: "Setup", lines });
    if (!r.ok) throw new Error(`post failed: ${r.code} ${r.error}`);
  };
  const periods = await db.select().from(fiscalPeriods).where(eq(fiscalPeriods.organizationId, t.org.id)).orderBy(fiscalPeriods.startDate);
  const period = (n: number) => periods[n - 1];
  const status = async (n: number) => (await db.select().from(fiscalPeriods).where(eq(fiscalPeriods.id, period(n).id)))[0];
  const je = (actor: Actor, date: string, extra: Partial<journals.CreateJournalEntryInput> = {}) =>
    run(actor, (ctx) =>
      journals.createJournalEntry(ctx, {
        date,
        description: "Accrue rent",
        lines: [
          { accountId: rent.id, debit: "40" },
          { accountId: cash.id, credit: "40" },
        ],
        post: true,
        ...extra,
      })
    );

  let task!: Awaited<ReturnType<typeof close.createCloseTask>>;
  section("Checklist");
  await check("January: an unreconciled bank, a draft invoice, an uncategorized expense, and an unsigned item", async () => {
    await post("2026-01-10", [
      { accountId: cash.id, debit: "1000" },
      { accountId: sales.id, credit: "1000" },
    ]);
    await post("2026-01-15", [
      { accountId: uncategorized.id, debit: "50" },
      { accountId: cash.id, credit: "50" },
    ]);
    const customer = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Draft Co" }));
    await run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: customer.id, invoiceDate: "2026-01-20", lines: [{ description: "x", unitPrice: "10", accountId: sales.id }] }));
    task = await run(accountant, (ctx) => close.createCloseTask(ctx, { title: "Review payroll" }));
    const c = await run(viewer, (ctx) => close.closeChecklist(ctx, { id: period(1).id }));
    const byKey = Object.fromEntries(c.checks.map((x) => [x.key, x]));
    assert(!byKey.reconciled.ok && byKey.reconciled.items[0]?.label.startsWith("1010 Checking: never reconciled"), JSON.stringify(byKey.reconciled));
    assert(!byKey.drafts.ok && byKey.drafts.items.some((i) => i.label === "1 invoices"), JSON.stringify(byKey.drafts.items));
    assert(!byKey.holding.ok && byKey.holding.items[0]?.label === "6900 Uncategorized Expense: $50.00", JSON.stringify(byKey.holding.items));
    assert(byKey.ar_ties.ok && byKey.ap_ties.ok && byKey.undeposited.ok && byKey.recurring.ok && byKey.for_review.ok, "the rest pass");
    assertEq(c.tasks.map((x) => `${x.title}:${x.done}`).join(), "Review payroll:false", "the company's item");
    assertEq(c.openItems, 4, "three checks and one item open");
    assertEq(c.alsoCloses.length, 0, "nothing earlier");
    const feb = await run(viewer, (ctx) => close.closeChecklist(ctx, { id: period(2).id }));
    assertEq(feb.alsoCloses.join(), "FY2026-01", "closing February closes January too");
  });
  await check("a reconciliation through the period end and a reclass clear their checks", async () => {
    await db.insert(reconciliations).values({ organizationId: t.org.id, accountId: cash.id, statementEndDate: "2026-01-31", statementEndingBalance: "950", beginningBalance: "0", status: "completed", completedAt: new Date() });
    await post("2026-01-31", [
      { accountId: rent.id, debit: "50" },
      { accountId: uncategorized.id, credit: "50" },
    ]);
    const c = await run(viewer, (ctx) => close.closeChecklist(ctx, { id: period(1).id }));
    const byKey = Object.fromEntries(c.checks.map((x) => [x.key, x]));
    assert(byKey.reconciled.ok, byKey.reconciled.detail);
    assert(byKey.holding.ok, byKey.holding.detail);
    assertEq(c.openItems, 2, "the draft and the item remain");
  });

  section("Who may close");
  await check("agents read the checklist but can't close; bookkeepers and accountants can't either", async () => {
    const c = await run(agent, (ctx) => close.closeChecklist(ctx, { id: period(1).id }));
    assertEq(c.period.periodCode, "FY2026-01", "agents read it");
    await expectError(() => run(agent, (ctx) => close.closePeriod(ctx, { id: period(1).id, note: "x" })), "forbidden");
    await expectError(() => run(accountant, (ctx) => close.closePeriod(ctx, { id: period(1).id, note: "x" })), "forbidden");
    await expectError(() => run(bookkeeper, (ctx) => close.closePeriod(ctx, { id: period(1).id, note: "x" })), "forbidden");
    await expectError(() => run(agent, (ctx) => close.createCloseTask(ctx, { title: "x" })), "forbidden");
    await expectError(() => run(bookkeeper, (ctx) => close.createCloseTask(ctx, { title: "x" })), "forbidden");
  });

  section("Soft close");
  await check("open items need a note; with one, January soft closes and the note is kept", async () => {
    await expectError(() => run(admin, (ctx) => close.closePeriod(ctx, { id: period(1).id })), "invalid_input");
    const r = await run(admin, (ctx) => close.closePeriod(ctx, { id: period(1).id, note: "Draft invoice is a duplicate; payroll reviewed offline" }));
    assertEq(r.closed.join(), "FY2026-01", "closed");
    const p = await status(1);
    assertEq(p.status, "soft_closed", "status");
    assert(p.closeNote?.startsWith("Draft invoice"), "note kept");
    assert(p.firstClosedAt, "first close recorded");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, p.id), eq(auditLog.event, "fiscal_period.soft_closed")));
    assertEq((audit.metadata as { openItems: string[] }).openItems.length, 2, "open items in the audit row");
    await expectError(() => run(admin, (ctx) => close.closePeriod(ctx, { id: period(1).id, note: "x" })), "invalid_state");
  });
  await check("a soft-closed period takes adjusting entries only; sign-offs on it are locked", async () => {
    await expectError(() => je(accountant, "2026-01-20"), "posting_failed");
    const adj = await je(accountant, "2026-01-20", { adjusting: true });
    assertEq(adj.status, "posted", "adjusting entry posted");
    assertEq(adj.source, "adjusting", "source");
    await expectError(() => run(bookkeeper, (ctx) => close.setCloseTask(ctx, { id: period(1).id, taskId: task.id })), "invalid_state");
  });
  await check("closing March closes February with it", async () => {
    const r = await run(admin, (ctx) => close.closePeriod(ctx, { id: period(3).id, note: "Quarter end" }));
    assertEq(r.closed.join(), "FY2026-02,FY2026-03", "both");
  });

  section("Hard close and the closing password");
  await check("only the owner sets the closing password; changing it takes the current one", async () => {
    await expectError(() => run(admin, (ctx) => close.closePeriod(ctx, { id: period(3).id, level: "hard", note: "x", password: "anything" })), "invalid_state");
    await expectError(() => run(admin, (ctx) => close.setClosingPassword(ctx, { password: "close-pass-1" })), "forbidden");
    await run(owner, (ctx) => close.setClosingPassword(ctx, { password: "close-pass-1" }));
    await expectError(() => run(owner, (ctx) => close.setClosingPassword(ctx, { password: "close-pass-2", currentPassword: "wrong-pass" })), "invalid_input");
    await run(owner, (ctx) => close.setClosingPassword(ctx, { password: "close-pass-2", currentPassword: "close-pass-1" }));
    assert(await run(viewer, (ctx) => close.hasClosingPassword(ctx)), "set");
  });
  await check("hard close through March takes the password", async () => {
    await expectError(() => run(admin, (ctx) => close.closePeriod(ctx, { id: period(3).id, level: "hard", note: "x", password: "close-pass-1" })), "invalid_input");
    const r = await run(admin, (ctx) => close.closePeriod(ctx, { id: period(3).id, level: "hard", note: "Q1 final", password: "close-pass-2" }));
    assertEq(r.closed.join(), "FY2026-01,FY2026-02,FY2026-03", "all three hard closed");
    assertEq((await status(2)).status, "hard_closed", "February");
  });
  await check("a hard-closed period takes a person's closing password; agents can't use it", async () => {
    await expectError(() => je(accountant, "2026-02-10", { adjusting: true }), "posting_failed");
    const forced = await je(owner, "2026-02-10", { closingPassword: "close-pass-2", overrideReason: "Late utility bill" });
    assertEq(forced.status, "posted", "posted with the password");
    assert(forced.overrideHardClose, "marked as an override");
    const draft = await run(owner, (ctx) =>
      journals.createJournalEntry(ctx, { date: "2026-02-11", description: "Draft", lines: [{ accountId: rent.id, debit: "5" }, { accountId: cash.id, credit: "5" }] })
    );
    await expectError(() => run({ ...agent, role: "accountant" }, (ctx) => journals.postJournalEntry(ctx, { id: draft.id, closingPassword: "close-pass-2", overrideReason: "x" })), "forbidden");
  });

  section("Reopen");
  await check("reopening February takes a reason and the password, and reopens March too", async () => {
    await expectError(() => run(admin, (ctx) => close.reopenPeriod(ctx, { id: period(2).id, reason: "" })), "invalid_input");
    await expectError(() => run(admin, (ctx) => close.reopenPeriod(ctx, { id: period(2).id, reason: "Missed invoice" })), "invalid_input");
    await expectError(() => run(agent, (ctx) => close.reopenPeriod(ctx, { id: period(2).id, reason: "x", password: "close-pass-2" })), "forbidden");
    const r = await run(admin, (ctx) => close.reopenPeriod(ctx, { id: period(2).id, reason: "Missed invoice", password: "close-pass-2" }));
    assertEq(r.reopened.join(), "FY2026-02,FY2026-03", "February and March");
    assertEq((await status(1)).status, "hard_closed", "January stays closed");
    const feb = await status(2);
    assertEq(feb.status, "open", "February open");
    assert(feb.firstClosedAt, "first close kept");
    assertEq(feb.closeNote, null, "note cleared");
    await je(accountant, "2026-02-12");
  });

  section("Your checklist items");
  await check("bookkeepers sign items off for an open period and take them back; retired items drop off", async () => {
    await run(bookkeeper, (ctx) => close.setCloseTask(ctx, { id: period(4).id, taskId: task.id, note: "Payroll matched" }));
    let c = await run(viewer, (ctx) => close.closeChecklist(ctx, { id: period(4).id }));
    assertEq(c.tasks[0].done, true, "done");
    assertEq(c.tasks[0].note, "Payroll matched", "note");
    assert(c.tasks[0].completedByEmail, "who");
    await expectError(() => run(agent, (ctx) => close.setCloseTask(ctx, { id: period(4).id, taskId: task.id })), "forbidden");
    await run(bookkeeper, (ctx) => close.setCloseTask(ctx, { id: period(4).id, taskId: task.id, done: false }));
    c = await run(viewer, (ctx) => close.closeChecklist(ctx, { id: period(4).id }));
    assertEq(c.tasks[0].done, false, "taken back");
    await run(accountant, (ctx) => close.updateCloseTask(ctx, { id: task.id, isActive: false }));
    c = await run(viewer, (ctx) => close.closeChecklist(ctx, { id: period(4).id }));
    assertEq(c.tasks.length, 0, "retired");
    assertEq((await run(viewer, (ctx) => close.listCloseTasks(ctx))).length, 1, "still listed");
  });

  section("Changes after close");
  await check("the adjusting entry, the override, and February's post after reopening are listed", async () => {
    const r = await run(viewer, (ctx) => close.changesAfterClose(ctx, { from: "2026-01-01", to: "2026-12-31" }));
    const labels = r.rows.filter((x) => x.kind === "account").map((x) => x.label);
    assertEq(labels.length, 3, labels.join(" | "));
    assert(labels[1].endsWith("(override: Late utility bill)"), labels[1]);
    assertEq(r.rows[0].values[0], "FY2026-01", "period");
    assertEq(row(r, "3 journals")[4], "120.00", "total debits");
    const csv = await run(viewer, (ctx) => exportReport(ctx, { report: "changes-after-close", from: "2026-01-01", to: "2026-12-31" }));
    assert(csv.bytes.toString().includes("Late utility bill"), "CSV");
  });

  section("Year end");
  await check("the balance sheet splits prior years' earnings from this year's net income", async () => {
    await db.transaction((tx) => generateFiscalYear(tx, { organizationId: t.org.id, startDate: "2027-01-01", yearLabel: "FY2027" }));
    await post("2027-01-05", [
      { accountId: cash.id, debit: "300" },
      { accountId: sales.id, credit: "300" },
    ]);
    const pnl2026 = await run(viewer, (ctx) => profitAndLossTable(ctx, { from: "2026-01-01", to: "2026-12-31" }));
    const ni2026 = row(pnl2026, "Net Income")[0];
    const bs = await run(viewer, (ctx) => reportTable(ctx, { report: "balance-sheet", asOf: "2027-01-31" }));
    assertEq(row(bs, "Retained Earnings (prior years)")[0], ni2026, "2026 net income");
    assertEq(row(bs, "Net Income")[0], "300.00", "2027 so far");
    assertEq(row(bs, "Total Liabilities and Equity")[0], row(bs, "Total Assets")[0], "balances");
  });
  await check("hard closing December closes FY2026; the P&L keeps its history; reopening opens the year", async () => {
    const r = await run(admin, (ctx) => close.closePeriod(ctx, { id: period(12).id, level: "hard", note: "Year end", password: "close-pass-2" }));
    assertEq(r.yearClosed, "FY2026", "year closed");
    assertEq(r.closed.length, 11, "February through December");
    const [fy] = await db.select().from(fiscalYears).where(and(eq(fiscalYears.organizationId, t.org.id), eq(fiscalYears.yearLabel, "FY2026")));
    assertEq(fy.status, "closed", "status");
    const pnl = await run(viewer, (ctx) => profitAndLossTable(ctx, { from: "2026-01-01", to: "2026-12-31" }));
    assertEq(row(pnl, "Total Operating Revenue")[0], "1000.00", "no closing entry");
    await run(admin, (ctx) => close.reopenPeriod(ctx, { id: period(12).id, reason: "Audit adjustment", password: "close-pass-2" }));
    const [again] = await db.select().from(fiscalYears).where(eq(fiscalYears.id, fy.id));
    assertEq(again.status, "open", "reopened");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
