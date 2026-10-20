/**
 * End-to-end: recurring bills. The daily run (scheduled: create and submit
 * for approval; reminder: a draft in the review queue; days in advance;
 * catching up), ending after a number of bills, pause and resume, using a
 * template by hand, a failed run recorded on the template, delete, and the
 * role rules.
 *
 *   npx tsx scripts/test-recurring-bills.ts
 */
import { addDays, addMonths, format } from "date-fns";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { apBills, vendors } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as bills from "../src/lib/ap/bills";
import * as recurring from "../src/lib/ap/recurring-bills";
import { money } from "../src/lib/money";
import { listReviewQueue } from "../src/lib/review";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

const day = (d: Date) => format(d, "yyyy-MM-dd");

async function main() {
  const t = await createTestOrg("rbill-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);
  const rent = account(t, "6600");
  const utilities = account(t, "6610");
  const [landlord] = await db.insert(vendors).values({ organizationId: t.org.id, code: "V-1", name: "Landlord LLC" }).returning();
  const [power] = await db.insert(vendors).values({ organizationId: t.org.id, code: "V-2", name: "Power Co" }).returning();

  const start = addDays(new Date(), 5);
  let scheduledId = "";

  section("Scheduled");
  await check("a scheduled template waits for its first date", async () => {
    const tpl = await run(bookkeeper, (ctx) =>
      recurring.createRecurringBill(ctx, {
        name: "Office rent",
        vendorId: landlord.id,
        type: "scheduled",
        frequency: "monthly",
        startDate: day(start),
        description: "Monthly rent",
        lines: [{ accountId: rent.id, amount: "2500", description: "Suite 200" }],
      })
    );
    scheduledId = tpl.id;
    assertEq(tpl.nextRunDate, day(start), "next date");
    assertEq(money(tpl.totalAmount).toFixed(2), "2500.00", "total");
    const r = await recurring.runRecurringBillsForOrg(t.org.id, day(new Date()));
    assertEq(r.created, 0, "nothing due yet");
  });
  await check("two months on: three bills, each submitted for approval, schedule moved on", async () => {
    const r = await recurring.runRecurringBillsForOrg(t.org.id, day(addMonths(start, 2)));
    assertEq(r.created, 3, "created");
    assertEq(r.submitted, 3, "submitted");
    const made = await db.select().from(apBills).where(eq(apBills.recurringBillId, scheduledId));
    assertEq(made.length, 3, "bills linked to the template");
    assert(made.every((b) => b.status === "pending_approval"), "all pending approval");
    assert(made.some((b) => b.billDate === day(start)), "first bill dated on the start date");
    const tpl = await run(viewer, (ctx) => recurring.getRecurringBill(ctx, { id: scheduledId }));
    assertEq(tpl.occurrences, 3, "occurrences");
    assertEq(tpl.nextRunDate, day(addMonths(start, 3)), "next date");
    assertEq(tpl.bills.length, 3, "bills listed on the template");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(made.every((b) => queue.some((q) => q.id === b.id && q.reason === "awaiting_approval")), "in the review queue for approval");
  });

  section("Reminder, days in advance, ending");
  let reminderId = "";
  await check("a reminder created 3 days early lands as a draft in the review queue", async () => {
    const first = addDays(new Date(), 10);
    const tpl = await run(bookkeeper, (ctx) =>
      recurring.createRecurringBill(ctx, {
        name: "Electric",
        vendorId: power.id,
        type: "reminder",
        frequency: "monthly",
        startDate: day(first),
        daysInAdvance: 3,
        maxOccurrences: 2,
        lines: [{ accountId: utilities.id, amount: "180" }],
      })
    );
    reminderId = tpl.id;
    assertEq((await recurring.runRecurringBillsForOrg(t.org.id, day(addDays(first, -4)))).created, 0, "too early");
    const r = await recurring.runRecurringBillsForOrg(t.org.id, day(addDays(first, -3)));
    assertEq(r.created, 1, "created 3 days ahead");
    const [b] = await db.select().from(apBills).where(eq(apBills.recurringBillId, reminderId));
    assertEq(b.status, "draft", "a draft");
    assertEq(b.billDate, day(first), "dated on the schedule date");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(queue.some((q) => q.id === b.id && q.reason === "recurring"), "in the review queue as a recurring draft");
  });
  await check("after its 2 bills the template ends", async () => {
    const r = await recurring.runRecurringBillsForOrg(t.org.id, day(addMonths(new Date(), 3)));
    assert(r.created >= 1, "made the second");
    const tpl = await run(viewer, (ctx) => recurring.getRecurringBill(ctx, { id: reminderId }));
    assertEq(tpl.occurrences, 2, "two bills");
    assertEq(tpl.status, "ended", "ended");
    await expectError(() => run(bookkeeper, (ctx) => recurring.setRecurringBillStatus(ctx, { id: reminderId, status: "active" })), "invalid_state");
  });

  section("Pause, resume, use by hand");
  await check("paused templates don't run; resuming skips the missed dates", async () => {
    await run(bookkeeper, (ctx) => recurring.setRecurringBillStatus(ctx, { id: scheduledId, status: "paused" }));
    const before = (await db.select().from(apBills).where(eq(apBills.recurringBillId, scheduledId))).length;
    await recurring.runRecurringBillsForOrg(t.org.id, day(addMonths(start, 6)));
    assertEq((await db.select().from(apBills).where(eq(apBills.recurringBillId, scheduledId))).length, before, "nothing while paused");
    const resumed = await run(bookkeeper, (ctx) => recurring.setRecurringBillStatus(ctx, { id: scheduledId, status: "active" }));
    assert(resumed.nextRunDate! >= day(new Date()), "next date is today or later");
  });
  await check("unscheduled: never runs; use it to make a bill (and submit it)", async () => {
    const tpl = await run(bookkeeper, (ctx) =>
      recurring.createRecurringBill(ctx, { name: "Snow removal", vendorId: power.id, type: "unscheduled", lines: [{ accountId: utilities.id, amount: "75" }] })
    );
    assertEq(tpl.nextRunDate, null, "no schedule");
    const b = await run(bookkeeper, (ctx) => recurring.createBillFromRecurring(ctx, { id: tpl.id, billDate: "2026-06-15", submit: true }));
    assertEq(b.status, "pending_approval", "submitted");
    assertEq(b.recurringBillId, tpl.id, "linked");
    assertEq(money(b.totalAmount).toFixed(2), "75.00", "amount");
  });

  section("Failures and guards");
  await check("a run that can't make its bill records the error and leaves the schedule alone", async () => {
    const first = addDays(new Date(), 2);
    const tpl = await run(bookkeeper, (ctx) =>
      recurring.createRecurringBill(ctx, { name: "Water", vendorId: power.id, type: "scheduled", startDate: day(first), lines: [{ accountId: utilities.id, amount: "40" }] })
    );
    await db.update(vendors).set({ isActive: false }).where(eq(vendors.id, power.id));
    const r = await recurring.runRecurringBillsForOrg(t.org.id, day(first));
    assert(r.errors.some((e) => e.recurringBillId === tpl.id), "error reported");
    const after = await run(viewer, (ctx) => recurring.getRecurringBill(ctx, { id: tpl.id }));
    assert(after.lastError?.includes("inactive"), `lastError: ${after.lastError}`);
    assertEq(after.nextRunDate, day(first), "schedule not moved");
    assertEq(after.occurrences, 0, "nothing made");
    await db.update(vendors).set({ isActive: true }).where(eq(vendors.id, power.id));
  });
  await check("guards: past start dates, end before start, duplicate names, viewers", async () => {
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          recurring.createRecurringBill(ctx, { name: "Old", vendorId: landlord.id, type: "scheduled", startDate: "2020-01-01", lines: [{ accountId: rent.id, amount: "1" }] })
        ),
      "invalid_input"
    );
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          recurring.createRecurringBill(ctx, {
            name: "Backwards",
            vendorId: landlord.id,
            type: "scheduled",
            startDate: day(addDays(new Date(), 30)),
            endDate: day(addDays(new Date(), 20)),
            lines: [{ accountId: rent.id, amount: "1" }],
          })
        ),
      "invalid_input"
    );
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          recurring.createRecurringBill(ctx, { name: "Office rent", vendorId: landlord.id, type: "unscheduled", lines: [{ accountId: rent.id, amount: "1" }] })
        ),
      "conflict"
    );
    await expectError(
      () => run(viewer, (ctx) => recurring.createRecurringBill(ctx, { name: "No", vendorId: landlord.id, type: "unscheduled", lines: [{ accountId: rent.id, amount: "1" }] })),
      "forbidden"
    );
  });
  await check("deleting a template keeps its bills", async () => {
    const before = await db.select().from(apBills).where(eq(apBills.recurringBillId, scheduledId));
    await run(bookkeeper, (ctx) => recurring.deleteRecurringBill(ctx, { id: scheduledId }));
    await expectError(() => run(viewer, (ctx) => recurring.getRecurringBill(ctx, { id: scheduledId })), "not_found");
    for (const b of before) {
      const kept = await run(viewer, (ctx) => bills.getBill(ctx, { id: b.id }));
      assertEq(kept.recurringBillId, null, "unlinked, still there");
    }
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
