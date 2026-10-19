/**
 * End-to-end: bill payments through the service layer — partial payment,
 * early-pay discount treatment, paid-status recompute, over-application
 * guards (at create AND at post), and void.
 *
 *   npx tsx scripts/test-ap-payments.ts
 */
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { apBills, glJournals, glLines, vendors } from "../src/lib/db/schema";
import * as bills from "../src/lib/ap/bills";
import * as billPayments from "../src/lib/ap/bill-payments";
import { money } from "../src/lib/money";
import {
  account,
  assert,
  assertEq,
  check,
  createTestOrg,
  deleteOrgs,
  expectError,
  finish,
  section,
} from "./lib/harness";

async function main() {
  const t = await createTestOrg("appay-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");

  const [vendor] = await db
    .insert(vendors)
    .values({ organizationId: t.org.id, code: "V-1", name: "Lumber Co" })
    .returning();
  const [vendor2] = await db
    .insert(vendors)
    .values({ organizationId: t.org.id, code: "V-2", name: "Other Co" })
    .returning();

  const cash = account(t, "1010");
  const materials = account(t, "5100");
  const apControl = account(t, "2000");
  const discounts = account(t, "4940");

  const linesOf = async (journalId: string) =>
    db.select().from(glLines).where(eq(glLines.journalId, journalId));
  const billStatus = async (id: string) =>
    (await db.select().from(apBills).where(eq(apBills.id, id)))[0].status;

  let billId = "";
  section("Setup");
  await check("post bill $1000 (Dr Materials / Cr AP)", async () => {
    const b = await t.run(owner, async (ctx) => {
      const created = await bills.createBill(ctx, {
        vendorId: vendor.id,
        billDate: "2026-03-01",
        lines: [{ accountId: materials.id, amount: "1000" }],
        submit: true,
      });
      await bills.approveBill(ctx, { id: created.id });
      return bills.postBill(ctx, { id: created.id });
    });
    billId = b.id;
    assertEq(b.status, "posted", "status");
  });

  section("Partial payment");
  let firstPaymentId = "";
  await check("create + post $400: Dr AP 400 / Cr Bank 400", async () => {
    const p = await t.run(owner, (ctx) =>
      billPayments.createBillPayment(ctx, {
        vendorId: vendor.id,
        paymentDate: "2026-03-10",
        method: "check",
        reference: "1234",
        bankAccountId: cash.id,
        applications: [{ billId, amount: "400" }],
        post: true,
      })
    );
    firstPaymentId = p.id;
    assertEq(p.status, "posted", "status");
    const lines = await linesOf(p.glJournalId!);
    assertEq(money(lines.find((l) => l.accountId === apControl.id)!.debit).toFixed(2), "400.00", "AP debit");
    assertEq(money(lines.find((l) => l.accountId === cash.id)!.credit).toFixed(2), "400.00", "Bank credit");
  });

  await check("bill is still 'posted' with 600 open", async () => {
    assertEq(await billStatus(billId), "posted", "status");
    const b = await t.run(owner, (ctx) => bills.getBill(ctx, { id: billId }));
    assertEq(money(b.openBalance).toFixed(2), "600.00", "open");
  });

  section("Guards");
  await check("over-application is rejected at create", async () => {
    await expectError(
      () =>
        t.run(owner, (ctx) =>
          billPayments.createBillPayment(ctx, {
            vendorId: vendor.id,
            paymentDate: "2026-03-11",
            method: "ach",
            bankAccountId: cash.id,
            applications: [{ billId, amount: "601" }],
          })
        ),
      "invalid_input"
    );
  });

  await check("paying a bill under the wrong vendor is rejected", async () => {
    await expectError(
      () =>
        t.run(owner, (ctx) =>
          billPayments.createBillPayment(ctx, {
            vendorId: vendor2.id,
            paymentDate: "2026-03-11",
            method: "ach",
            bankAccountId: cash.id,
            applications: [{ billId, amount: "10" }],
          })
        ),
      "invalid_input"
    );
  });

  await check("non-cash 'bank' account is rejected", async () => {
    await expectError(
      () =>
        t.run(owner, (ctx) =>
          billPayments.createBillPayment(ctx, {
            vendorId: vendor.id,
            paymentDate: "2026-03-11",
            method: "ach",
            bankAccountId: materials.id,
            applications: [{ billId, amount: "10" }],
          })
        ),
      "invalid_input"
    );
  });

  await check("two drafts that together overpay: the second post is refused", async () => {
    const [a, b] = await t.run(owner, async (ctx) => [
      await billPayments.createBillPayment(ctx, {
        vendorId: vendor.id,
        paymentDate: "2026-03-12",
        method: "ach",
        bankAccountId: cash.id,
        applications: [{ billId, amount: "500" }],
      }),
      await billPayments.createBillPayment(ctx, {
        vendorId: vendor.id,
        paymentDate: "2026-03-12",
        method: "ach",
        bankAccountId: cash.id,
        applications: [{ billId, amount: "500" }],
      }),
    ]);
    await t.run(owner, (ctx) => billPayments.postBillPayment(ctx, { id: a.id }));
    await expectError(
      () => t.run(owner, (ctx) => billPayments.postBillPayment(ctx, { id: b.id })),
      "invalid_input"
    );
    // Undo the 500 so the discount scenario below starts from 600 open.
    await t.run(owner, (ctx) => billPayments.voidBillPayment(ctx, { id: a.id, reason: "test" }));
    await t.run(owner, (ctx) => billPayments.deleteDraftBillPayment(ctx, { id: b.id }));
  });

  section("Early-pay discount");
  let discountPaymentId = "";
  await check("pay 580 cash + 20 discount: Dr AP 600 / Cr Bank 580 / Cr Discount 20", async () => {
    const p = await t.run(owner, (ctx) =>
      billPayments.createBillPayment(ctx, {
        vendorId: vendor.id,
        paymentDate: "2026-03-15",
        method: "ach",
        bankAccountId: cash.id,
        applications: [{ billId, amount: "580", discountAmount: "20" }],
        post: true,
      })
    );
    discountPaymentId = p.id;
    assertEq(money(p.appliedAmount).toFixed(2), "600.00", "header gross");
    assertEq(money(p.netAmount).toFixed(2), "580.00", "header net");
    const lines = await linesOf(p.glJournalId!);
    assertEq(lines.length, 3, "line count");
    assertEq(money(lines.find((l) => l.accountId === apControl.id)!.debit).toFixed(2), "600.00", "AP");
    assertEq(money(lines.find((l) => l.accountId === cash.id)!.credit).toFixed(2), "580.00", "Bank");
    assertEq(money(lines.find((l) => l.accountId === discounts.id)!.credit).toFixed(2), "20.00", "Discount");
  });

  await check("bill flips to 'paid' once cash + discount covers it", async () => {
    assertEq(await billStatus(billId), "paid", "status");
  });

  section("Void");
  await check("void the discount payment: reversal posted, bill back to 'posted'", async () => {
    const p = await t.run(owner, (ctx) =>
      billPayments.voidBillPayment(ctx, { id: discountPaymentId, reason: "bounced" })
    );
    assertEq(p.status, "voided", "payment status");
    const [orig] = await db.select().from(glJournals).where(eq(glJournals.id, p.glJournalId!));
    assertEq(orig.status, "reversed", "original journal");
    assertEq(await billStatus(billId), "posted", "bill status");
  });

  await check("bookkeeper cannot void payments", async () => {
    await expectError(
      () =>
        t.run(t.as("bookkeeper"), (ctx) =>
          billPayments.voidBillPayment(ctx, { id: firstPaymentId, reason: "x" })
        ),
      "forbidden"
    );
  });

  await check("list shows vendor names and filters by status", async () => {
    const page = await t.run(owner, (ctx) =>
      billPayments.listBillPayments(ctx, { status: "voided" })
    );
    assert(page.data.length >= 1, "at least one voided");
    assert(page.data.every((p) => p.status === "voided" && p.vendorName === "Lumber Co"), "rows");
  });

  await deleteOrgs("appay-test-");
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
