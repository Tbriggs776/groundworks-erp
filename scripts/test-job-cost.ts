/**
 * End-to-end verification of Tier 2.3 — Job Cost reporting.
 *
 * Exercises:
 *   - getJobCostSummary: budget + actual + variance + open budget
 *   - getJobsCostSummary: cross-job rollup
 *   - getJobCostDetail: line-level drilldown
 *   - Reversal handling: voided AP bill nets actuals back to zero
 *   - Unbudgeted detection: actual posted to a code with no budget row
 *
 *   npx tsx scripts/test-job-cost.ts
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
  costCodes,
  customers,
  jobCostCodes,
  jobs,
  memberships,
  organizations,
  profiles,
  vendors,
} from "../src/lib/db/schema";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";
import {
  syncCostCodeDimensionValue,
  syncJobDimensionValue,
} from "../src/lib/projects/dimension-sync";
import { postBillToGl, voidBillFromGl } from "../src/lib/ap/posting";
import {
  getJobCostDetail,
  getJobCostSummary,
  getJobsCostSummary,
} from "../src/lib/projects/job-cost";
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
  const testSlug = `job-cost-test-${Date.now()}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx
      .delete(organizations)
      .where(like(organizations.slug, "job-cost-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "Job Cost Test", slug: testSlug, baseCurrency: "USD" })
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
        name: "ACME Concrete",
        vendorType: "supplier",
      })
      .returning();

    const [customer] = await tx
      .insert(customers)
      .values({
        organizationId: org.id,
        code: "CUST-001",
        name: "Test Customer",
        customerType: "commercial",
      })
      .returning();

    // Create cost codes (with dimension sync so AP posting can attach
    // the COST_CODE dimension value)
    const [concreteDim, laborDim, oopsDim] = await Promise.all([
      syncCostCodeDimensionValue(tx, org.id, {
        code: "03-30-00",
        name: "Cast-in-Place Concrete",
      }),
      syncCostCodeDimensionValue(tx, org.id, {
        code: "01-50-00",
        name: "Temporary Facilities",
      }),
      syncCostCodeDimensionValue(tx, org.id, {
        code: "99-99-99",
        name: "Unbudgeted Catch-all",
      }),
    ]);
    const [concreteCC] = await tx
      .insert(costCodes)
      .values({
        organizationId: org.id,
        code: "03-30-00",
        name: "Cast-in-Place Concrete",
        costType: "subcontractor",
        dimensionValueId: concreteDim,
      })
      .returning();
    const [laborCC] = await tx
      .insert(costCodes)
      .values({
        organizationId: org.id,
        code: "01-50-00",
        name: "Temporary Facilities",
        costType: "labor",
        dimensionValueId: laborDim,
      })
      .returning();
    const [oopsCC] = await tx
      .insert(costCodes)
      .values({
        organizationId: org.id,
        code: "99-99-99",
        name: "Unbudgeted Catch-all",
        costType: "other",
        dimensionValueId: oopsDim,
      })
      .returning();

    // Create job + JOB dim value
    const jobDim = await syncJobDimensionValue(tx, org.id, {
      code: "J-100",
      name: "Warehouse Build",
    });
    const [job] = await tx
      .insert(jobs)
      .values({
        organizationId: org.id,
        code: "J-100",
        name: "Warehouse Build",
        customerId: customer.id,
        contractAmount: "500000",
        status: "active",
        dimensionValueId: jobDim,
      })
      .returning();

    // Budget rows: $50k concrete, $5k temp facilities. Note: oopsCC has NO
    // budget row — used to test the "unbudgeted" surface.
    await tx.insert(jobCostCodes).values([
      {
        organizationId: org.id,
        jobId: job.id,
        costCodeId: concreteCC.id,
        budgetAmount: "50000",
      },
      {
        organizationId: org.id,
        jobId: job.id,
        costCodeId: laborCC.id,
        budgetAmount: "5000",
      },
    ]);

    const acctRows = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, org.id));
    const byCode = new Map(acctRows.map((a) => [a.code, a]));

    return {
      org,
      vendor,
      customer,
      job,
      concreteCC,
      laborCC,
      oopsCC,
      materials: byCode.get("5100")!, // COGS Materials
      subContractor: byCode.get("5300")!, // COGS Subcontractor
      labor: byCode.get("5000")!, // COGS Labor
      apControl: byCode.get("2000")!,
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  console.log("Empty state");
  await check("summary returns rows for budgeted codes with zero actuals", async () => {
    const s = await getJobCostSummary(fixtures.org.id, fixtures.job.id);
    if (!s) throw new Error("no summary returned");
    if (s.rows.length !== 2)
      throw new Error(`expected 2 budgeted rows, got ${s.rows.length}`);
    if (!money(s.totalActual).isZero())
      throw new Error(`expected actual=0, got ${s.totalActual}`);
    if (!money(s.totalBudget).equals(55000))
      throw new Error(`expected budget=55000, got ${s.totalBudget}`);
    if (s.unbudgetedCount !== 0)
      throw new Error(`unexpected unbudgeted: ${s.unbudgetedCount}`);
  });

  await check("est. gross profit = contract - actual at empty state", async () => {
    const s = await getJobCostSummary(fixtures.org.id, fixtures.job.id);
    if (!s) throw new Error("no summary");
    if (!money(s.estimatedGrossProfit).equals(500000))
      throw new Error(`expected EGP=500000, got ${s.estimatedGrossProfit}`);
  });

  console.log("\nPost an AP bill that hits two budgeted codes");
  await check("post bill: $30k concrete + $1500 temp facilities", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .insert(apBills)
        .values({
          organizationId: fixtures.org.id,
          billNumber: "AP-001",
          vendorInvoiceNumber: "INV-1",
          vendorId: fixtures.vendor.id,
          billDate: "2026-03-01",
          dueDate: "2026-03-31",
          subtotalAmount: "31500",
          totalAmount: "31500",
          status: "approved",
        })
        .returning();

      await tx.insert(apBillLines).values([
        {
          organizationId: fixtures.org.id,
          billId: bill.id,
          lineNumber: 1,
          accountId: fixtures.subContractor.id,
          jobId: fixtures.job.id,
          costCodeId: fixtures.concreteCC.id,
          amount: "30000",
          description: "Foundation pour",
        },
        {
          organizationId: fixtures.org.id,
          billId: bill.id,
          lineNumber: 2,
          accountId: fixtures.labor.id,
          jobId: fixtures.job.id,
          costCodeId: fixtures.laborCC.id,
          amount: "1500",
          description: "Site temp office",
        },
      ]);

      const res = await postBillToGl(tx, {
        bill,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
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

  console.log("\nActuals reflect posted bill");
  await check("concrete actual = 30000, variance = 20000", async () => {
    const s = await getJobCostSummary(fixtures.org.id, fixtures.job.id);
    if (!s) throw new Error("no summary");
    const concrete = s.rows.find((r) => r.costCodeId === fixtures.concreteCC.id);
    if (!concrete) throw new Error("concrete row missing");
    if (!money(concrete.actual).equals(30000))
      throw new Error(`expected actual=30000, got ${concrete.actual}`);
    if (!money(concrete.variance).equals(20000))
      throw new Error(`expected variance=20000, got ${concrete.variance}`);
    if (concrete.percentUsed !== 60)
      throw new Error(`expected 60% used, got ${concrete.percentUsed}`);
  });

  await check("labor actual = 1500, variance = 3500", async () => {
    const s = await getJobCostSummary(fixtures.org.id, fixtures.job.id);
    if (!s) throw new Error("no summary");
    const labor = s.rows.find((r) => r.costCodeId === fixtures.laborCC.id);
    if (!labor) throw new Error("labor row missing");
    if (!money(labor.actual).equals(1500))
      throw new Error(`expected actual=1500, got ${labor.actual}`);
    if (!money(labor.variance).equals(3500))
      throw new Error(`expected variance=3500, got ${labor.variance}`);
  });

  await check("rollup: total actual = 31500, totalVariance = 23500", async () => {
    const s = await getJobCostSummary(fixtures.org.id, fixtures.job.id);
    if (!s) throw new Error("no summary");
    if (!money(s.totalActual).equals(31500))
      throw new Error(`expected totalActual=31500, got ${s.totalActual}`);
    if (!money(s.totalVariance).equals(23500))
      throw new Error(`expected totalVariance=23500, got ${s.totalVariance}`);
  });

  console.log("\nUnbudgeted detection");
  let unbudgetedBillId: string | null = null;
  await check("post a bill against the un-budgeted cost code (oops)", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .insert(apBills)
        .values({
          organizationId: fixtures.org.id,
          billNumber: "AP-002",
          vendorInvoiceNumber: "INV-2",
          vendorId: fixtures.vendor.id,
          billDate: "2026-03-02",
          dueDate: "2026-04-01",
          subtotalAmount: "750",
          totalAmount: "750",
          status: "approved",
        })
        .returning();
      unbudgetedBillId = bill.id;

      await tx.insert(apBillLines).values([
        {
          organizationId: fixtures.org.id,
          billId: bill.id,
          lineNumber: 1,
          accountId: fixtures.materials.id,
          jobId: fixtures.job.id,
          costCodeId: fixtures.oopsCC.id,
          amount: "750",
          description: "Misc that nobody budgeted",
        },
      ]);

      const res = await postBillToGl(tx, {
        bill,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
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

  await check("summary surfaces unbudgeted code with budget=0, actual=750", async () => {
    const s = await getJobCostSummary(fixtures.org.id, fixtures.job.id);
    if (!s) throw new Error("no summary");
    if (s.unbudgetedCount !== 1)
      throw new Error(`expected unbudgetedCount=1, got ${s.unbudgetedCount}`);
    const oops = s.rows.find((r) => r.costCodeId === fixtures.oopsCC.id);
    if (!oops) throw new Error("oops row missing");
    if (!oops.unbudgeted) throw new Error("oops should be flagged unbudgeted");
    if (!money(oops.budget).isZero())
      throw new Error(`expected budget=0, got ${oops.budget}`);
    if (!money(oops.actual).equals(750))
      throw new Error(`expected actual=750, got ${oops.actual}`);
    if (oops.percentUsed !== null)
      throw new Error("percentUsed should be null when budget=0");
  });

  console.log("\nDetail drilldown");
  await check("getJobCostDetail returns the posted lines for (job, concrete)", async () => {
    const lines = await getJobCostDetail(
      fixtures.org.id,
      fixtures.job.id,
      fixtures.concreteCC.id
    );
    if (lines.length !== 1)
      throw new Error(`expected 1 line, got ${lines.length}`);
    if (!money(lines[0].debit).equals(30000))
      throw new Error(`expected debit=30000, got ${lines[0].debit}`);
    if (lines[0].source !== "ap")
      throw new Error(`expected source=ap, got ${lines[0].source}`);
  });

  console.log("\nReversal handling");
  await check("void the unbudgeted bill — actual nets back to 0", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(apBills)
        .where(eq(apBills.id, unbudgetedBillId!));
      const res = await voidBillFromGl(tx, {
        bill,
        actorId: actor.id,
        organizationId: fixtures.org.id,
        reason: "Wrong cost code",
      });
      await tx
        .update(apBills)
        .set({
          status: "voided",
          voidedAt: sql`now()`,
          voidGlJournalId: res.journalId,
          voidReason: "Wrong cost code",
        })
        .where(eq(apBills.id, bill.id));
    });
  });

  await check("after void: oops row nets to actual=0; concrete/labor unaffected", async () => {
    const s = await getJobCostSummary(fixtures.org.id, fixtures.job.id);
    if (!s) throw new Error("no summary");
    // Reversal lines DO carry jobId/costCodeId, so the cost_code_id
    // appears in the GROUP BY result with sum=0. The unbudgeted-detection
    // logic surfaces the row because there's no budget for that code,
    // letting the PM see something happened on this code (even if it
    // netted to zero).
    const oops = s.rows.find((r) => r.costCodeId === fixtures.oopsCC.id);
    if (oops && !money(oops.actual).isZero()) {
      throw new Error(`expected oops actual=0 after void, got ${oops.actual}`);
    }
    // Concrete + labor unaffected
    if (!money(s.totalActual).equals(31500))
      throw new Error(`expected totalActual=31500, got ${s.totalActual}`);
  });

  console.log("\nCross-job report (getJobsCostSummary)");
  await check("report has one row for our active job, totals correct", async () => {
    const rows = await getJobsCostSummary(fixtures.org.id);
    const j = rows.find((r) => r.jobId === fixtures.job.id);
    if (!j) throw new Error("job missing from report");
    if (!money(j.totalBudget).equals(55000))
      throw new Error(`expected budget=55000, got ${j.totalBudget}`);
    if (!money(j.totalActual).equals(31500))
      throw new Error(`expected actual=31500, got ${j.totalActual}`);
    if (!money(j.contractAmount).equals(500000))
      throw new Error(`expected contract=500000, got ${j.contractAmount}`);
    if (!money(j.estimatedGrossProfit).equals(468500))
      throw new Error(`expected EGP=468500, got ${j.estimatedGrossProfit}`);
  });

  await check("closed jobs hidden by default", async () => {
    // Close the job
    await db
      .update(jobs)
      .set({ status: "closed", actualEndDate: "2026-12-31" })
      .where(eq(jobs.id, fixtures.job.id));
    const rows = await getJobsCostSummary(fixtures.org.id);
    if (rows.find((r) => r.jobId === fixtures.job.id)) {
      throw new Error("closed job should be hidden");
    }
  });

  await check("closed jobs visible with includeClosed=true", async () => {
    const rows = await getJobsCostSummary(fixtures.org.id, {
      includeClosed: true,
    });
    if (!rows.find((r) => r.jobId === fixtures.job.id))
      throw new Error("closed job should appear with includeClosed");
  });

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx
      .delete(organizations)
      .where(eq(organizations.id, fixtures.org.id));
  });

  // unused-import guards
  void and;

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
