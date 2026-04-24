/**
 * End-to-end verification of Tier 2.2b — AP payments against posted bills,
 * including early-pay discount treatment, bill paid-status recompute, and
 * void reversal.
 *
 *   npx tsx scripts/test-ap-payments.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  accounts,
  apBillLines,
  apBills,
  apPaymentApplications,
  apPayments,
  glLines,
  memberships,
  organizations,
  profiles,
  sourceCodes,
  vendors,
} from "../src/lib/db/schema";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { createAndPostJournal } from "../src/lib/gl/posting";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";
import {
  postPaymentToGl,
  recomputeBillPaymentStatus,
  voidPaymentFromGl,
} from "../src/lib/ap/payments";
import { postBillToGl } from "../src/lib/ap/posting";
import { money } from "../src/lib/money";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ${PASS} ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ${FAIL} ${name}`);
    console.log(`     ${(e as Error).message}`);
  }
}

async function main() {
  const testSlug = `ap-pay-test-${Date.now()}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx
      .delete(organizations)
      .where(like(organizations.slug, "ap-pay-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "AP Pay Test", slug: testSlug, baseCurrency: "USD" })
      .returning();
    await tx.insert(memberships).values({
      organizationId: org.id,
      userId: actor.id,
      role: "owner",
    });
    await seedOrganizationDefaults(tx, org.id, {
      includeContractorCoa: true,
      includeCsiCostCodes: false,
    });
    await generateFiscalYear(tx, {
      organizationId: org.id,
      startDate: "2026-01-01",
      yearLabel: "FY2026",
    });

    const [vendor] = await tx
      .insert(vendors)
      .values({
        organizationId: org.id,
        code: "V-001",
        name: "ABC Supply",
        vendorType: "supplier",
      })
      .returning();

    const acctRows = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, org.id));
    const byCode = new Map(acctRows.map((a) => [a.code, a]));

    return {
      org,
      vendor,
      cash: byCode.get("1010")!,
      materials: byCode.get("5100")!,
      apControl: byCode.get("2000")!,
      discounts: byCode.get("4940")!,
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  console.log("Setup — post a bill");
  let billId: string | null = null;
  let billGlJournalId: string | null = null;

  await check("post bill $1000 (Dr Materials / Cr AP Control)", async () => {
    await db.transaction(async (tx) => {
      // Build a bill
      const [bill] = await tx
        .insert(apBills)
        .values({
          organizationId: fixtures.org.id,
          billNumber: "AP-000001",
          vendorInvoiceNumber: "INV-1",
          vendorId: fixtures.vendor.id,
          billDate: "2026-03-01",
          dueDate: "2026-03-31",
          discountDate: "2026-03-11",
          currency: "USD",
          exchangeRate: "1",
          subtotalAmount: "1000",
          totalAmount: "1000",
          status: "approved",
        })
        .returning();
      billId = bill.id;

      await tx.insert(apBillLines).values({
        organizationId: fixtures.org.id,
        billId: bill.id,
        lineNumber: 1,
        accountId: fixtures.materials.id,
        amount: "1000",
        description: "Concrete materials",
      });

      // Post via helper
      const res = await postBillToGl(tx, {
        bill,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
      billGlJournalId = res.journalId;

      await tx
        .update(apBills)
        .set({
          status: "posted",
          postedAt: sql`now()`,
          postingDate: bill.billDate,
          glJournalId: res.journalId,
        })
        .where(eq(apBills.id, bill.id));
    });
  });

  await check("posted bill's GL journal has 2 lines, balanced", async () => {
    const lines = await db
      .select()
      .from(glLines)
      .where(eq(glLines.journalId, billGlJournalId!));
    if (lines.length !== 2)
      throw new Error(`expected 2 lines, got ${lines.length}`);
    const totalDr = lines.reduce((a, l) => a.plus(money(l.debitLocal)), money(0));
    const totalCr = lines.reduce((a, l) => a.plus(money(l.creditLocal)), money(0));
    if (!totalDr.equals(totalCr)) throw new Error("unbalanced");
    if (!totalDr.equals(1000))
      throw new Error(`expected total=1000, got ${totalDr}`);
  });

  console.log("\nPartial payment ($400, no discount)");
  let paymentId: string | null = null;
  await check("create + post payment $400", async () => {
    await db.transaction(async (tx) => {
      const [payment] = await tx
        .insert(apPayments)
        .values({
          organizationId: fixtures.org.id,
          paymentNumber: "APPAY-000001",
          vendorId: fixtures.vendor.id,
          paymentDate: "2026-03-15",
          method: "check",
          reference: "1234",
          bankAccountId: fixtures.cash.id,
          currency: "USD",
          exchangeRate: "1",
          appliedAmount: "400",
          discountAmount: "0",
          netAmount: "400",
          status: "draft",
        })
        .returning();
      paymentId = payment.id;

      await tx.insert(apPaymentApplications).values({
        organizationId: fixtures.org.id,
        paymentId: payment.id,
        billId: billId!,
        appliedAmount: "400",
        discountAmount: "0",
      });

      const res = await postPaymentToGl(tx, {
        payment,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
      await tx
        .update(apPayments)
        .set({
          status: "posted",
          postedAt: sql`now()`,
          glJournalId: res.journalId,
        })
        .where(eq(apPayments.id, payment.id));
      await recomputeBillPaymentStatus(tx, fixtures.org.id, billId!);
    });
  });

  await check("bill still 'posted' after partial payment", async () => {
    const [b] = await db
      .select()
      .from(apBills)
      .where(eq(apBills.id, billId!));
    if (b.status !== "posted")
      throw new Error(`expected posted, got ${b.status}`);
    if (b.paidAt) throw new Error("paidAt should be null");
  });

  await check("payment's GL journal: Dr AP $400, Cr Bank $400", async () => {
    const [pm] = await db
      .select()
      .from(apPayments)
      .where(eq(apPayments.id, paymentId!));
    const lines = await db
      .select()
      .from(glLines)
      .where(eq(glLines.journalId, pm.glJournalId!));
    if (lines.length !== 2)
      throw new Error(`expected 2 lines (no discount), got ${lines.length}`);
    const apLine = lines.find((l) => l.accountId === fixtures.apControl.id);
    const bankLine = lines.find((l) => l.accountId === fixtures.cash.id);
    if (!apLine || !money(apLine.debitLocal).equals(400))
      throw new Error("expected Dr AP 400");
    if (!bankLine || !money(bankLine.creditLocal).equals(400))
      throw new Error("expected Cr Bank 400");
  });

  console.log("\nFinal payment ($600 applied + $20 discount = $580 net)");
  let discountPaymentId: string | null = null;
  await check("create + post payment closing the bill", async () => {
    await db.transaction(async (tx) => {
      // Bill had $1000; we applied $400 already. Remaining $600.
      // Pay with $580 net + $20 discount → applies $600 (closes the bill).
      const [payment] = await tx
        .insert(apPayments)
        .values({
          organizationId: fixtures.org.id,
          paymentNumber: "APPAY-000002",
          vendorId: fixtures.vendor.id,
          paymentDate: "2026-03-10", // within discount window (≤ 03-11)
          method: "ach",
          reference: "ACH-5678",
          bankAccountId: fixtures.cash.id,
          currency: "USD",
          exchangeRate: "1",
          appliedAmount: "600",
          discountAmount: "20",
          netAmount: "580",
          status: "draft",
        })
        .returning();
      discountPaymentId = payment.id;

      await tx.insert(apPaymentApplications).values({
        organizationId: fixtures.org.id,
        paymentId: payment.id,
        billId: billId!,
        appliedAmount: "580",
        discountAmount: "20",
      });

      const res = await postPaymentToGl(tx, {
        payment,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
      await tx
        .update(apPayments)
        .set({
          status: "posted",
          postedAt: sql`now()`,
          glJournalId: res.journalId,
        })
        .where(eq(apPayments.id, payment.id));
      await recomputeBillPaymentStatus(tx, fixtures.org.id, billId!);
    });
  });

  await check("bill flips to 'paid' once total applied = total", async () => {
    const [b] = await db
      .select()
      .from(apBills)
      .where(eq(apBills.id, billId!));
    if (b.status !== "paid")
      throw new Error(`expected paid, got ${b.status}`);
    if (!b.paidAt) throw new Error("paidAt should be set");
  });

  await check("discount payment's GL: Dr AP 600, Cr Bank 580, Cr Discount 20", async () => {
    const [pm] = await db
      .select()
      .from(apPayments)
      .where(eq(apPayments.id, discountPaymentId!));
    const lines = await db
      .select()
      .from(glLines)
      .where(eq(glLines.journalId, pm.glJournalId!));
    if (lines.length !== 3)
      throw new Error(`expected 3 lines (with discount), got ${lines.length}`);
    const ap = lines.find((l) => l.accountId === fixtures.apControl.id);
    const bank = lines.find((l) => l.accountId === fixtures.cash.id);
    const disc = lines.find((l) => l.accountId === fixtures.discounts.id);
    if (!ap || !money(ap.debitLocal).equals(600))
      throw new Error(`Dr AP expected 600, got ${ap?.debitLocal}`);
    if (!bank || !money(bank.creditLocal).equals(580))
      throw new Error(`Cr Bank expected 580, got ${bank?.creditLocal}`);
    if (!disc || !money(disc.creditLocal).equals(20))
      throw new Error(`Cr Discount expected 20, got ${disc?.creditLocal}`);
  });

  console.log("\nVoid the discount payment");
  await check("void payment → reverses GL, bill drops back to 'posted'", async () => {
    await db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(apPayments)
        .where(eq(apPayments.id, discountPaymentId!));
      const res = await voidPaymentFromGl(tx, {
        payment,
        actorId: actor.id,
        organizationId: fixtures.org.id,
        reason: "Test void",
      });
      await tx
        .update(apPayments)
        .set({
          status: "voided",
          voidedAt: sql`now()`,
          voidReason: "Test void",
          voidGlJournalId: res.journalId,
        })
        .where(eq(apPayments.id, discountPaymentId!));
      await recomputeBillPaymentStatus(tx, fixtures.org.id, billId!);
    });
    const [b] = await db
      .select()
      .from(apBills)
      .where(eq(apBills.id, billId!));
    if (b.status !== "posted")
      throw new Error(`expected posted, got ${b.status}`);
    if (b.paidAt) throw new Error("paidAt should be null after void");
  });

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, fixtures.org.id));
  });
  void createAndPostJournal;
  void sourceCodes;

  console.log(
    `\n${failed === 0 ? PASS : FAIL} ${
      failed === 0 ? "all checks passed" : `${failed} check(s) failed`
    }\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
