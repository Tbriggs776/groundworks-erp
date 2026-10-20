/**
 * End-to-end: estimates (status, progress invoicing by remaining, percent,
 * and custom amounts, the billing caps, closing and reopening) and
 * recurring invoices (scheduled, reminder, unscheduled; the daily run, its
 * catch-up and end rules, posting failures, pause / resume, use now) plus
 * the role / agent rules.
 *
 *   npx tsx scripts/test-estimates.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { format } from "date-fns";
import { db } from "../src/lib/db/client";
import { arInvoices, auditLog, recurringInvoices } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as estimates from "../src/lib/ar/estimates";
import * as invoices from "../src/lib/ar/invoices";
import * as itemsSvc from "../src/lib/ar/items";
import * as recurring from "../src/lib/ar/recurring-invoices";
import { money } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import { listReviewQueue } from "../src/lib/review";
import * as rates from "../src/lib/sales-tax/rates";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

const m2 = (v: string) => money(v).toFixed(2);

async function main() {
  const t = await createTestOrg("estimates-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const sales = account(t, "4000");
  const servicesIncome = account(t, "4100");

  const widget = await run(owner, (ctx) => itemsSvc.createItem(ctx, { name: "Widget", type: "non_inventory", salesPrice: "100", incomeAccountId: sales.id }));
  const consulting = await run(owner, (ctx) =>
    itemsSvc.createItem(ctx, { name: "Consulting", salesPrice: "50", incomeAccountId: servicesIncome.id, taxable: false })
  );
  const acme = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Acme Builders" }));
  const agency = await run(accountant, (ctx) => rates.createTaxAgency(ctx, { name: "State DOR" }));
  const eight = await run(accountant, (ctx) => rates.createTaxRate(ctx, { name: "Eight", agencyId: agency.id, ratePercent: "8" }));

  // =========================================================================
  section("Estimates");
  let est!: estimates.EstimateDetail;
  await check("an estimate quotes like an invoice and touches nothing in the ledger", async () => {
    await expectError(
      () => run(viewer, (ctx) => estimates.createEstimate(ctx, { customerId: acme.id, estimateDate: "2026-03-01", lines: [{ itemId: widget.id }] })),
      "forbidden"
    );
    est = await run(bookkeeper, (ctx) =>
      estimates.createEstimate(ctx, {
        customerId: acme.id,
        estimateDate: "2026-03-01",
        expirationDate: "2026-03-31",
        taxCodeId: eight.id,
        memo: "Phase 1 build",
        lines: [
          { itemId: widget.id, quantity: "10" },
          { itemId: consulting.id, quantity: "4" },
          { accountId: sales.id, description: "Loyalty discount", unitPrice: "-100", taxable: true },
        ],
      })
    );
    assert(est.estimateNumber.startsWith("EST-"), "numbered EST-");
    assertEq(est.status, "pending", "starts pending");
    assertEq(m2(est.subtotalAmount), "1100.00", "subtotal");
    assertEq(m2(est.taxableAmount), "900.00", "taxable (widget less discount)");
    assertEq(m2(est.taxAmount), "72.00", "tax");
    assertEq(m2(est.totalAmount), "1172.00", "total");
    assertEq(m2(est.remainingAmount), "1100.00", "all left to bill");
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          estimates.createEstimate(ctx, { customerId: acme.id, estimateDate: "2026-03-01", expirationDate: "2026-02-01", lines: [{ itemId: widget.id }] })
        ),
      "invalid_input"
    );
  });
  await check("accepting records who and when", async () => {
    const e = await run(bookkeeper, (ctx) => estimates.setEstimateStatus(ctx, { id: est.id, status: "accepted", acceptedBy: "Jo at Acme" }));
    assertEq(e.status, "accepted", "accepted");
    assertEq(e.acceptedBy, "Jo at Acme", "by");
    assertEq(e.acceptedDate, format(new Date(), "yyyy-MM-dd"), "today");
  });

  section("Progress invoicing");
  let inv1!: invoices.InvoiceDetail;
  await check("50% bills half of every line, keeping rates and the tax rate", async () => {
    await expectError(
      () => run(bookkeeper, (ctx) => estimates.createInvoiceFromEstimate(ctx, { id: est.id, invoiceDate: "2026-03-10", mode: "percent", percent: "150" })),
      "invalid_input"
    );
    inv1 = await run(bookkeeper, (ctx) =>
      estimates.createInvoiceFromEstimate(ctx, { id: est.id, invoiceDate: "2026-03-10", mode: "percent", percent: "50" })
    );
    assertEq(inv1.status, "draft", "a draft");
    assertEq(inv1.estimate?.number, est.estimateNumber, "points at the estimate");
    assertEq(m2(inv1.subtotalAmount), "550.00", "half the subtotal");
    assertEq(m2(inv1.taxAmount), "36.00", "tax on 450");
    assertEq(inv1.memo, "Phase 1 build", "message carried over");
    const w = inv1.lines.find((l) => l.itemId === widget.id)!;
    assertEq(money(w.quantity).toString(), "5", "5 of 10 widgets");
    assertEq(m2(w.unitPrice), "100.00", "same rate");
    assert(inv1.lines.every((l) => l.estimateLineId), "every line linked");
    const e = await run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: est.id }));
    assertEq(m2(e.billedAmount), "550.00", "billed");
    assertEq(m2(e.remainingAmount), "550.00", "left");
    assertEq(e.status, "accepted", "still accepted");
  });
  await check("billing can't pass what's left, flip a line's sign, or move to another customer", async () => {
    const e = await run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: est.id }));
    const widgetLine = e.lines.find((l) => l.itemId === widget.id)!;
    const discountLine = e.lines.find((l) => money(l.amount).isNegative())!;
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          estimates.createInvoiceFromEstimate(ctx, { id: est.id, invoiceDate: "2026-03-11", mode: "custom", lines: [{ estimateLineId: widgetLine.id, amount: "500.01" }] })
        ),
      "invalid_input"
    );
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          estimates.createInvoiceFromEstimate(ctx, {
            id: est.id,
            invoiceDate: "2026-03-11",
            mode: "custom",
            lines: [
              { estimateLineId: widgetLine.id, amount: "100" },
              { estimateLineId: discountLine.id, amount: "10" },
            ],
          })
        ),
      "invalid_input"
    );
    // Editing the draft keeps its links and the same caps.
    const lines = inv1.lines.map((l) => ({
      itemId: l.itemId ?? undefined,
      accountId: l.accountId,
      description: l.description ?? undefined,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
      estimateLineId: l.estimateLineId ?? undefined,
    }));
    const edited = await run(bookkeeper, (ctx) =>
      invoices.updateInvoice(ctx, { id: inv1.id, customerId: acme.id, invoiceDate: "2026-03-10", taxCodeId: eight.id, lines })
    );
    assert(edited.lines.every((l) => l.estimateLineId), "links kept on edit");
    const tooMuch = lines.map((l) => (l.itemId === widget.id ? { ...l, quantity: "11" } : l));
    await expectError(
      () => run(bookkeeper, (ctx) => invoices.updateInvoice(ctx, { id: inv1.id, customerId: acme.id, invoiceDate: "2026-03-10", lines: tooMuch })),
      "invalid_input"
    );
    const other = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Other Co" }));
    await expectError(
      () => run(bookkeeper, (ctx) => invoices.updateInvoice(ctx, { id: inv1.id, customerId: other.id, invoiceDate: "2026-03-10", lines })),
      "invalid_input"
    );
    // A plain invoice can't claim estimate lines.
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-03-10", lines: [{ itemId: widget.id, estimateLineId: widgetLine.id }] })
        ),
      "invalid_input"
    );
  });
  await check("an invoiced estimate's lines are fixed; it can't be rejected or deleted", async () => {
    await expectError(
      () => run(bookkeeper, (ctx) => estimates.updateEstimate(ctx, { id: est.id, customerId: acme.id, estimateDate: "2026-03-01", lines: [{ itemId: widget.id }] })),
      "invalid_state"
    );
    await expectError(() => run(bookkeeper, (ctx) => estimates.setEstimateStatus(ctx, { id: est.id, status: "rejected" })), "invalid_state");
    await expectError(() => run(bookkeeper, (ctx) => estimates.deleteEstimate(ctx, { id: est.id })), "invalid_state");
  });
  let inv2!: invoices.InvoiceDetail;
  await check("billing the rest closes the estimate; nothing more can be billed", async () => {
    await run(bookkeeper, (ctx) => invoices.postInvoice(ctx, { id: inv1.id }));
    inv2 = await run(bookkeeper, (ctx) =>
      estimates.createInvoiceFromEstimate(ctx, { id: est.id, invoiceDate: "2026-03-20", mode: "remaining", post: true })
    );
    assertEq(inv2.status, "open", "posted");
    assertEq(m2(inv2.subtotalAmount), "550.00", "the other half");
    const e = await run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: est.id }));
    assertEq(e.status, "closed", "closed on its own");
    assertEq(m2(e.remainingAmount), "0.00", "nothing left");
    assertEq(e.invoices.length, 2, "two invoices");
    await expectError(
      () => run(bookkeeper, (ctx) => estimates.createInvoiceFromEstimate(ctx, { id: est.id, invoiceDate: "2026-03-21" })),
      "invalid_state"
    );
    await expectError(() => run(bookkeeper, (ctx) => estimates.setEstimateStatus(ctx, { id: est.id, status: "accepted" })), "invalid_state");
  });
  await check("voiding a progress invoice puts its amount back and reopens the estimate", async () => {
    await run(owner, (ctx) => invoices.voidInvoice(ctx, { id: inv2.id, reason: "Billed too early" }));
    const e = await run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: est.id }));
    assertEq(e.status, "accepted", "reopened as accepted");
    assertEq(m2(e.remainingAmount), "550.00", "half left again");
    // A draft holds its share until deleted.
    const draft = await run(bookkeeper, (ctx) => estimates.createInvoiceFromEstimate(ctx, { id: est.id, invoiceDate: "2026-03-25" }));
    assertEq((await run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: est.id }))).status, "closed", "closed while the draft exists");
    await run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: draft.id }));
    const after = await run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: est.id }));
    assertEq(after.status, "accepted", "reopened after the draft is deleted");
    assertEq(m2(after.remainingAmount), "550.00", "still half left");
  });
  await check("a custom amount keeps the rate when it can, else bills 1 × the amount", async () => {
    const e = await run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: est.id }));
    const widgetLine = e.lines.find((l) => l.itemId === widget.id)!;
    const inv = await run(bookkeeper, (ctx) =>
      estimates.createInvoiceFromEstimate(ctx, { id: est.id, invoiceDate: "2026-03-26", mode: "custom", lines: [{ estimateLineId: widgetLine.id, amount: "123.45" }] })
    );
    assertEq(money(inv.lines[0].quantity).toString(), "1.2345", "fractional quantity");
    assertEq(m2(inv.lines[0].amount), "123.45", "exact amount");
    await run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: inv.id }));

    const big = await run(bookkeeper, (ctx) =>
      estimates.createEstimate(ctx, { customerId: acme.id, estimateDate: "2026-03-01", lines: [{ accountId: sales.id, description: "Big job", unitPrice: "250000" }] })
    );
    const inv3 = await run(bookkeeper, (ctx) =>
      estimates.createInvoiceFromEstimate(ctx, { id: big.id, invoiceDate: "2026-03-26", mode: "custom", lines: [{ estimateLineId: big.lines[0].id, amount: "0.01" }] })
    );
    assertEq(money(inv3.lines[0].quantity).toString(), "1", "falls back to quantity 1");
    assertEq(m2(inv3.lines[0].unitPrice), "0.01", "rate = amount");
  });
  await check("estimates with no invoices can be edited, rejected, reopened, and deleted", async () => {
    const e = await run(bookkeeper, (ctx) =>
      estimates.createEstimate(ctx, { customerId: acme.id, estimateDate: "2026-04-01", lines: [{ itemId: consulting.id }] })
    );
    const edited = await run(bookkeeper, (ctx) =>
      estimates.updateEstimate(ctx, { id: e.id, customerId: acme.id, estimateDate: "2026-04-02", lines: [{ itemId: consulting.id, quantity: "3" }] })
    );
    assertEq(m2(edited.totalAmount), "150.00", "edited");
    assertEq((await run(bookkeeper, (ctx) => estimates.setEstimateStatus(ctx, { id: e.id, status: "rejected" }))).status, "rejected", "rejected");
    await expectError(() => run(bookkeeper, (ctx) => estimates.createInvoiceFromEstimate(ctx, { id: e.id, invoiceDate: "2026-04-03" })), "invalid_state");
    assertEq((await run(bookkeeper, (ctx) => estimates.setEstimateStatus(ctx, { id: e.id, status: "pending" }))).status, "pending", "reopened");
    await run(bookkeeper, (ctx) => estimates.deleteEstimate(ctx, { id: e.id }));
    await expectError(() => run(bookkeeper, (ctx) => estimates.getEstimate(ctx, { id: e.id })), "not_found");
  });
  await check("an agent in draft mode quotes and bills, and the invoice waits for review", async () => {
    const token = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Quote bot", autonomy: "draft" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const agent = await authenticateApiKey(token, "api");
    const e = await run(agent, (ctx) =>
      estimates.createEstimate(ctx, { customerId: acme.id, estimateDate: "2026-04-05", lines: [{ itemId: widget.id }] })
    );
    const inv = await run(agent, (ctx) => estimates.createInvoiceFromEstimate(ctx, { id: e.id, invoiceDate: "2026-04-06", post: true }));
    assertEq(inv.status, "draft", "kept as a draft");
    assert(inv.review?.required, "review notice");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(queue.some((q) => q.id === inv.id && q.reason === "agent_draft"), "in the review queue");
  });

  // =========================================================================
  section("Recurring invoices");
  const today = format(new Date(), "yyyy-MM-dd");
  /** Templates start today or later; tests move the schedule into FY2026 directly. */
  const moveTo = (id: string, date: string) =>
    db.update(recurringInvoices).set({ startDate: date, nextRunDate: date }).where(eq(recurringInvoices.id, id));
  const invoicesOf = (id: string) =>
    db.select().from(arInvoices).where(eq(arInvoices.recurringInvoiceId, id)).orderBy(arInvoices.invoiceDate);
  const runAt = (date: string) => recurring.runRecurringInvoicesForOrg(t.org.id, date);

  let monthly!: recurring.RecurringInvoiceDetail;
  await check("a template saves its lines and schedule; the first date can't be in the past", async () => {
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          recurring.createRecurringInvoice(ctx, {
            name: "Old",
            customerId: acme.id,
            type: "scheduled",
            startDate: "2020-01-01",
            lines: [{ itemId: consulting.id }],
          })
        ),
      "invalid_input"
    );
    await expectError(
      () => run(viewer, (ctx) => recurring.createRecurringInvoice(ctx, { name: "V", customerId: acme.id, type: "unscheduled", lines: [{ itemId: consulting.id }] })),
      "forbidden"
    );
    monthly = await run(bookkeeper, (ctx) =>
      recurring.createRecurringInvoice(ctx, {
        name: "Acme retainer",
        customerId: acme.id,
        type: "scheduled",
        frequency: "monthly",
        startDate: today,
        taxCodeId: eight.id,
        memo: "Monthly retainer",
        lines: [{ itemId: widget.id, quantity: "2" }],
      })
    );
    assertEq(monthly.nextRunDate, today, "next = start");
    assertEq(m2(monthly.totalAmount), "216.00", "preview total with tax");
    assertEq(monthly.status, "active", "active");
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          recurring.createRecurringInvoice(ctx, { name: "Acme retainer", customerId: acme.id, type: "unscheduled", lines: [{ itemId: consulting.id }] })
        ),
      "conflict"
    );
  });
  await check("the daily run posts scheduled invoices, catches up, and keeps the day of the month", async () => {
    await moveTo(monthly.id, "2026-01-31");
    assertEq((await runAt("2026-01-30")).created, 0, "not due yet");
    const r = await runAt("2026-03-31");
    assertEq(r.created, 3, "three invoices");
    assertEq(r.posted, 3, "all posted");
    assertEq(r.errors.length, 0, "no errors");
    const made = await invoicesOf(monthly.id);
    assertEq(made.map((i) => i.invoiceDate).join(","), "2026-01-31,2026-02-28,2026-03-31", "31st, then the last day of February, then the 31st");
    assert(made.every((i) => i.status === "open"), "posted");
    assertEq(m2(made[0].totalAmount), "216.00", "with tax");
    assertEq(made[0].memo, "Monthly retainer", "message");
    const tpl = await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: monthly.id }));
    assertEq(tpl.occurrences, 3, "counted");
    assertEq(tpl.nextRunDate, "2026-04-30", "April has 30 days");
    assertEq(tpl.lastInvoiceId, made[2].id, "last invoice");
    assertEq((await runAt("2026-03-31")).created, 0, "running again makes nothing");
    const audits = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, monthly.id), eq(auditLog.event, "ar.recurring_invoice.ran")));
    assertEq(audits[0].n, 3, "each run audited");
  });
  await check("a reminder makes a draft ahead of time and puts it in the review queue", async () => {
    const reminder = await run(bookkeeper, (ctx) =>
      recurring.createRecurringInvoice(ctx, {
        name: "Acme support",
        customerId: acme.id,
        type: "reminder",
        frequency: "monthly",
        daysInAdvance: 5,
        startDate: today,
        lines: [{ itemId: consulting.id }],
      })
    );
    await moveTo(reminder.id, "2026-04-10");
    assertEq((await runAt("2026-04-04")).created, 0, "6 days ahead: not yet");
    const r = await runAt("2026-04-05");
    assertEq(r.created, 1, "5 days ahead: created");
    assertEq(r.posted, 0, "not posted");
    const [draft] = await invoicesOf(reminder.id);
    assertEq(draft.status, "draft", "a draft");
    assertEq(draft.invoiceDate, "2026-04-10", "dated on the schedule");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(queue.some((q) => q.id === draft.id && q.reason === "recurring"), "in the review queue as recurring");
  });
  await check("templates end after their limit or end date", async () => {
    const weekly = await run(bookkeeper, (ctx) =>
      recurring.createRecurringInvoice(ctx, {
        name: "Weekly cleaning",
        customerId: acme.id,
        type: "scheduled",
        frequency: "weekly",
        maxOccurrences: 2,
        startDate: today,
        lines: [{ itemId: consulting.id }],
      })
    );
    await moveTo(weekly.id, "2026-05-01");
    await runAt("2026-05-31");
    assertEq((await invoicesOf(weekly.id)).length, 2, "two, then stops");
    const w = await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: weekly.id }));
    assertEq(w.status, "ended", "ended by count");
    assertEq((await invoicesOf(weekly.id)).map((i) => i.invoiceDate).join(","), "2026-05-01,2026-05-08", "weekly dates");

    const summer = await run(bookkeeper, (ctx) =>
      recurring.createRecurringInvoice(ctx, {
        name: "Summer lease",
        customerId: acme.id,
        type: "scheduled",
        frequency: "monthly",
        endDate: "2099-07-31",
        startDate: today,
        lines: [{ itemId: consulting.id }],
      })
    );
    await moveTo(summer.id, "2026-06-15");
    await db.update(recurringInvoices).set({ endDate: "2026-07-31" }).where(eq(recurringInvoices.id, summer.id));
    await runAt("2026-09-30");
    assertEq((await invoicesOf(summer.id)).map((i) => i.invoiceDate).join(","), "2026-06-15,2026-07-15", "June and July");
    assertEq((await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: summer.id }))).status, "ended", "ended by date");
  });
  await check("a post that's refused keeps the draft and records why", async () => {
    // No fiscal period covers 2027 in the test company.
    await moveTo(monthly.id, "2027-02-01");
    await runAt("2027-02-01");
    const tpl = await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: monthly.id }));
    assert(tpl.lastError?.includes("couldn't post"), "error kept on the template");
    const draft = (await invoicesOf(monthly.id)).find((i) => i.invoiceDate === "2027-02-01")!;
    assertEq(draft.status, "draft", "the draft waits for review");
    await run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: draft.id }));
  });
  await check("a template that can't make its invoice reports the error and tries again later", async () => {
    await run(owner, (ctx) => itemsSvc.updateItem(ctx, { id: widget.id, isActive: false }));
    await moveTo(monthly.id, "2026-06-30");
    const r = await runAt("2026-06-30");
    assert(r.errors.some((e) => e.recurringInvoiceId === monthly.id), "reported");
    const tpl = await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: monthly.id }));
    assert(tpl.lastError?.includes("inactive"), "why");
    assertEq(tpl.nextRunDate, "2026-06-30", "the schedule didn't move");
    await run(owner, (ctx) => itemsSvc.updateItem(ctx, { id: widget.id, isActive: true }));
    await runAt("2026-06-30");
    assert((await invoicesOf(monthly.id)).some((i) => i.invoiceDate === "2026-06-30"), "works once fixed");
    assertEq((await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: monthly.id }))).lastError, null, "error cleared");
  });
  await check("pausing stops the run; resuming skips the missed dates", async () => {
    await run(bookkeeper, (ctx) => recurring.setRecurringInvoiceStatus(ctx, { id: monthly.id, status: "paused" }));
    await moveTo(monthly.id, "2026-08-31");
    const before = (await invoicesOf(monthly.id)).length;
    await runAt("2026-09-30");
    assertEq((await invoicesOf(monthly.id)).length, before, "paused");
    const resumed = await run(bookkeeper, (ctx) => recurring.setRecurringInvoiceStatus(ctx, { id: monthly.id, status: "active" }));
    assert(resumed.nextRunDate! >= today, "next date is today or later");
    assertEq(resumed.status, "active", "active");
  });
  await check("using a template makes an invoice now without touching the schedule", async () => {
    const before = await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: monthly.id }));
    const inv = await run(bookkeeper, (ctx) => recurring.createInvoiceFromRecurring(ctx, { id: monthly.id, invoiceDate: "2026-08-15" }));
    assertEq(inv.status, "draft", "draft");
    assertEq(inv.recurring?.name, "Acme retainer", "points at the template");
    const after = await run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: monthly.id }));
    assertEq(after.occurrences, before.occurrences, "count unchanged");
    assertEq(after.nextRunDate, before.nextRunDate, "schedule unchanged");
    const unscheduled = await run(bookkeeper, (ctx) =>
      recurring.createRecurringInvoice(ctx, { name: "Ad hoc", customerId: acme.id, type: "unscheduled", lines: [{ itemId: consulting.id }] })
    );
    assertEq(unscheduled.nextRunDate, null, "no schedule");
    const posted = await run(bookkeeper, (ctx) =>
      recurring.createInvoiceFromRecurring(ctx, { id: unscheduled.id, invoiceDate: "2026-08-16", post: true })
    );
    assertEq(posted.status, "open", "posted when asked");
  });
  await check("editing moves the schedule forward only and can restart an ended template", async () => {
    const lines = [{ itemId: consulting.id, quantity: "2" }];
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          recurring.updateRecurringInvoice(ctx, { id: monthly.id, name: "Acme retainer", customerId: acme.id, type: "scheduled", nextRunDate: "2020-01-01", lines })
        ),
      "invalid_input"
    );
    const updated = await run(bookkeeper, (ctx) =>
      recurring.updateRecurringInvoice(ctx, { id: monthly.id, name: "Acme retainer", customerId: acme.id, type: "reminder", lines })
    );
    assertEq(updated.type, "reminder", "type changed");
    assertEq(m2(updated.subtotalAmount), "100.00", "lines replaced");
    const weekly = (await run(bookkeeper, (ctx) => recurring.listRecurringInvoices(ctx, { q: "Weekly" }))).data[0];
    const restarted = await run(bookkeeper, (ctx) =>
      recurring.updateRecurringInvoice(ctx, {
        id: weekly.id,
        name: weekly.name,
        customerId: acme.id,
        type: "scheduled",
        frequency: "weekly",
        maxOccurrences: 5,
        nextRunDate: today,
        lines: [{ itemId: consulting.id }],
      })
    );
    assertEq(restarted.status, "active", "restarted with a higher limit");
  });
  await check("agents: reminders freely; scheduled only with post scope and a limit that covers it", async () => {
    const draftToken = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Billing drafter", autonomy: "draft" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const drafter = await authenticateApiKey(draftToken, "api");
    await expectError(
      () =>
        run(drafter, (ctx) =>
          recurring.createRecurringInvoice(ctx, { name: "Bot sched", customerId: acme.id, type: "scheduled", startDate: today, lines: [{ itemId: consulting.id }] })
        ),
      "forbidden"
    );
    const rem = await run(drafter, (ctx) =>
      recurring.createRecurringInvoice(ctx, { name: "Bot reminder", customerId: acme.id, type: "reminder", startDate: today, lines: [{ itemId: consulting.id }] })
    );
    assert(rem.createdByAgentId, "agent-made");

    const postToken = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Billing poster", autonomy: "post", maxPostAmount: "100" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const poster = await authenticateApiKey(postToken, "api");
    await expectError(
      () =>
        run(poster, (ctx) =>
          recurring.createRecurringInvoice(ctx, { name: "Bot big", customerId: acme.id, type: "scheduled", startDate: today, lines: [{ itemId: widget.id, quantity: "2" }] })
        ),
      "forbidden"
    );
    const small = await run(poster, (ctx) =>
      recurring.createRecurringInvoice(ctx, { name: "Bot small", customerId: acme.id, type: "scheduled", startDate: today, lines: [{ itemId: consulting.id }] })
    );
    assertEq(small.type, "scheduled", "within the limit");
  });
  await check("deleting a template leaves its invoices", async () => {
    const before = await invoicesOf(monthly.id);
    await run(bookkeeper, (ctx) => recurring.deleteRecurringInvoice(ctx, { id: monthly.id }));
    const still = await db.select().from(arInvoices).where(eq(arInvoices.id, before[0].id));
    assertEq(still.length, 1, "invoice kept");
    assertEq(still[0].recurringInvoiceId, null, "link cleared");
    await expectError(() => run(bookkeeper, (ctx) => recurring.getRecurringInvoice(ctx, { id: monthly.id })), "not_found");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
