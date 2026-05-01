/**
 * Regression test for the AP-void-leaks-into-trial-balance bug.
 *
 * Before the fix, posting a reversal flipped the original journal's
 * status from 'posted' to 'reversed'. Every report that filtered
 * `status='posted'` (trial balance, balance sheet, income statement,
 * GL detail) then dropped the original entry's lines but kept the
 * reversal entry's lines, leaving a phantom net for every voided
 * document equal to the bill total. Trial balance still summed to
 * zero overall (debits flipped to credits and vice versa), but
 * individual account balances were wrong on both sides.
 *
 * After the fix, both entries stay 'posted' and net to zero on every
 * affected account. This script proves it end-to-end through the AP
 * bill flow.
 *
 *   npx tsx scripts/test-void-trial-balance.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq, like, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../src/lib/db/client";
import {
  accounts,
  apBillLines,
  apBills,
  glJournals,
  memberships,
  organizations,
  profiles,
  vendors,
} from "../src/lib/db/schema";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";
import { postBillToGl, voidBillFromGl } from "../src/lib/ap/posting";
import { reverseJournal } from "../src/lib/gl/posting";
import { getTrialBalance } from "../src/lib/gl/reports";
import { sumMoney } from "../src/lib/money";

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
  const testSlug = `void-tb-test-${Date.now()}`;

  // Cleanup leftover test orgs from prior runs
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "void-tb-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in once first.");

  // Set up org, CoA, fiscal year, vendor, draft bill
  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "Void TB Test", slug: testSlug, baseCurrency: "USD" })
      .returning();
    await tx.insert(memberships).values({
      organizationId: org.id,
      userId: actor.id,
      role: "owner",
    });
    await seedOrganizationDefaults(tx, org.id, { includeContractorCoa: true });
    await generateFiscalYear(tx, {
      organizationId: org.id,
      startDate: "2026-01-01",
      yearLabel: "FY2026",
    });

    const [vendor] = await tx
      .insert(vendors)
      .values({
        organizationId: org.id,
        code: "VEND-001",
        name: "Test Vendor",
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
      apControl: byCode.get("2000")!, // AP Trade — isControl
      materials: byCode.get("5100")!, // COGS Materials
      rent: byCode.get("6600")!, // Rent (SG&A)
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  // Build a 2-line bill: Materials 7,500 + Rent 2,500 = 10,000
  // Posting will produce JE: Dr Materials 7500, Dr Rent 2500, Cr AP 10000
  const BILL_TOTAL = "10000";
  const MATERIALS_AMOUNT = "7500";
  const RENT_AMOUNT = "2500";
  const POST_DATE = "2026-03-15";

  const billId = await db.transaction(async (tx) => {
    const [bill] = await tx
      .insert(apBills)
      .values({
        organizationId: fixtures.org.id,
        billNumber: "AP-000001",
        vendorInvoiceNumber: "INV-001",
        vendorId: fixtures.vendor.id,
        billDate: POST_DATE,
        dueDate: "2026-04-14",
        subtotalAmount: BILL_TOTAL,
        totalAmount: BILL_TOTAL,
        status: "approved",
        description: "Bill we'll post then void",
      })
      .returning();
    await tx.insert(apBillLines).values([
      {
        organizationId: fixtures.org.id,
        billId: bill.id,
        lineNumber: 1,
        accountId: fixtures.materials.id,
        amount: MATERIALS_AMOUNT,
      },
      {
        organizationId: fixtures.org.id,
        billId: bill.id,
        lineNumber: 2,
        accountId: fixtures.rent.id,
        amount: RENT_AMOUNT,
      },
    ]);
    return bill.id;
  });

  // ---------- POST ----------
  console.log("Post bill");
  await check("postBillToGl creates a posted journal", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(apBills)
        .where(eq(apBills.id, billId));
      const result = await postBillToGl(tx, {
        bill,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
      await tx
        .update(apBills)
        .set({
          status: "posted",
          postedAt: sql`now()`,
          postedBy: actor.id,
          postingDate: bill.billDate,
          glJournalId: result.journalId,
        })
        .where(eq(apBills.id, billId));
    });
    const [bill] = await db
      .select()
      .from(apBills)
      .where(eq(apBills.id, billId));
    if (bill.status !== "posted") throw new Error(`status=${bill.status}`);
    if (!bill.glJournalId) throw new Error("glJournalId missing");
  });

  await check("after posting: TB has the three accounts non-zero", async () => {
    const tb = await getTrialBalance(fixtures.org.id, {
      asOfDate: "2026-12-31",
    });
    const materials = tb.find((r) => r.code === "5100");
    const rent = tb.find((r) => r.code === "6600");
    const ap = tb.find((r) => r.code === "2000");
    if (!materials || !rent || !ap)
      throw new Error("missing 5100/6600/2000 in TB");
    if (!materials.netDebit.equals(MATERIALS_AMOUNT))
      throw new Error(`materials netDebit=${materials.netDebit} ≠ ${MATERIALS_AMOUNT}`);
    if (!rent.netDebit.equals(RENT_AMOUNT))
      throw new Error(`rent netDebit=${rent.netDebit} ≠ ${RENT_AMOUNT}`);
    if (!ap.netDebit.equals(new Decimal(BILL_TOTAL).neg()))
      throw new Error(`AP netDebit=${ap.netDebit} ≠ -${BILL_TOTAL}`);
  });

  // ---------- VOID ----------
  console.log("\nVoid bill");
  await check("voidBillFromGl creates a reversal journal", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(apBills)
        .where(eq(apBills.id, billId));
      const { journalId } = await voidBillFromGl(tx, {
        bill,
        actorId: actor.id,
        organizationId: fixtures.org.id,
        reason: "Wrong vendor",
      });
      await tx
        .update(apBills)
        .set({
          status: "voided",
          voidedAt: sql`now()`,
          voidedBy: actor.id,
          voidReason: "Wrong vendor",
          voidGlJournalId: journalId,
        })
        .where(eq(apBills.id, billId));
    });
    const [bill] = await db
      .select()
      .from(apBills)
      .where(eq(apBills.id, billId));
    if (bill.status !== "voided") throw new Error(`status=${bill.status}`);
    if (!bill.voidGlJournalId) throw new Error("voidGlJournalId missing");
  });

  await check(
    "original journal stays status='posted' after reversal posts",
    async () => {
      const [bill] = await db
        .select()
        .from(apBills)
        .where(eq(apBills.id, billId));
      const [original] = await db
        .select()
        .from(glJournals)
        .where(eq(glJournals.id, bill.glJournalId!));
      if (original.status !== "posted")
        throw new Error(
          `original journal status=${original.status}, expected 'posted' (reversal links via reversed_by_journal_id, not status)`
        );
      if (!original.reversedByJournalId)
        throw new Error("original.reversedByJournalId not set");
      if (original.reversedByJournalId !== bill.voidGlJournalId)
        throw new Error("reversed_by_journal_id ≠ void journal id");
    }
  );

  // The core assertion: trial balance must net to zero on every account
  // after a post + void cycle. Before the fix, this would FAIL — the
  // reversal lines stayed 'posted' but the original lines got hidden by
  // status='reversed', leaving phantom balances on Materials, Rent, and
  // AP equal to the bill amounts.
  console.log("\nTrial Balance after void");
  await check(
    "TB nets to zero on every account touched by the bill",
    async () => {
      const tb = await getTrialBalance(fixtures.org.id, {
        asOfDate: "2026-12-31",
        includeZero: true, // surface all so a phantom balance can't hide
      });
      for (const code of ["5100", "6600", "2000"]) {
        const row = tb.find((r) => r.code === code);
        if (!row) throw new Error(`missing ${code} in TB`);
        if (!row.netDebit.isZero()) {
          throw new Error(
            `Account ${code} netDebit=${row.netDebit} ≠ 0. Phantom balance from voided bill — the post+void should net to zero on every account.`
          );
        }
      }
    }
  );

  await check(
    "TB total debits = total credits (fundamental identity)",
    async () => {
      const tb = await getTrialBalance(fixtures.org.id, {
        asOfDate: "2026-12-31",
      });
      const totalDr = sumMoney(tb.map((r) => r.totalDebit));
      const totalCr = sumMoney(tb.map((r) => r.totalCredit));
      if (!totalDr.equals(totalCr)) {
        throw new Error(`Σ Dr=${totalDr} ≠ Σ Cr=${totalCr}`);
      }
    }
  );

  await check(
    "both journals (original + reversal) sit at status='posted'",
    async () => {
      const [bill] = await db
        .select()
        .from(apBills)
        .where(eq(apBills.id, billId));
      const original = await db
        .select({ status: glJournals.status })
        .from(glJournals)
        .where(eq(glJournals.id, bill.glJournalId!));
      const reversal = await db
        .select({ status: glJournals.status })
        .from(glJournals)
        .where(eq(glJournals.id, bill.voidGlJournalId!));
      if (original[0].status !== "posted")
        throw new Error(`original status=${original[0].status}`);
      if (reversal[0].status !== "posted")
        throw new Error(`reversal status=${reversal[0].status}`);
    }
  );

  // ---------- IDEMPOTENCY ----------
  console.log("\nDouble-void protection");
  await check(
    "second void attempt returns already_reversed (driven by reversed_by_journal_id, not status)",
    async () => {
      const [bill] = await db
        .select()
        .from(apBills)
        .where(eq(apBills.id, billId));
      // Bypass the bill state machine; call the underlying GL primitive
      // directly to make sure the GL-level guard still fires.
      const r = await reverseJournal(bill.glJournalId!, {
        actorId: actor.id,
        organizationId: fixtures.org.id,
        description: "Test double-void",
      });
      if (r.ok)
        throw new Error("expected reverseJournal to fail with already_reversed");
      if (r.code !== "already_reversed")
        throw new Error(`expected code=already_reversed, got ${r.code}`);
    }
  );

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, fixtures.org.id));
  });

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
