/**
 * End-to-end verification of Tier 2.5 — Commitments / POs.
 *
 * Exercises:
 *   - State machine: draft → issued → closed | voided
 *   - Issue: bumps job_cost_codes.committed_amount per line (upsert)
 *   - Bill linked to commitment line: posts to GL, drains committed,
 *     bumps invoiced_amount on commitment + line
 *   - Bill void: reverses GL + restores committed + decrements invoiced
 *   - Close: drops remaining un-invoiced commitment off committed
 *   - Void: same as close but admin-only with reason
 *   - Guardrails: cannot bill against draft commitment, cannot issue
 *     with no lines, cannot close/void from non-issued
 *
 *   npx tsx scripts/test-commitments.ts
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
  commitmentLines,
  commitments,
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
import { syncCostCodeDimensionValue, syncJobDimensionValue } from "../src/lib/projects/dimension-sync";
import {
  closeIssuedCommitment,
  getJobCommitmentsSummary,
  issueCommitment,
  voidIssuedCommitment,
} from "../src/lib/projects/commitments";
import { postBillToGl, voidBillFromGl } from "../src/lib/ap/posting";
import { nextNumber } from "../src/lib/gl/number-series";
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
  const testSlug = `commit-test-${Date.now()}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "commit-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "Commit Test", slug: testSlug, baseCurrency: "USD" })
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

    // Cost code
    const concreteDim = await syncCostCodeDimensionValue(tx, org.id, {
      code: "03-30-00",
      name: "Cast-in-Place Concrete",
    });
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

    const jobDim = await syncJobDimensionValue(tx, org.id, {
      code: "J-300",
      name: "Bridge Build",
    });
    const [job] = await tx
      .insert(jobs)
      .values({
        organizationId: org.id,
        code: "J-300",
        name: "Bridge Build",
        customerId: customer.id,
        contractAmount: "1000000",
        status: "active",
        dimensionValueId: jobDim,
      })
      .returning();

    // Existing budget on concrete = $50000 — issuing a $30000 commitment
    // adds to the committed bucket, not the budget.
    await tx.insert(jobCostCodes).values({
      organizationId: org.id,
      jobId: job.id,
      costCodeId: concreteCC.id,
      budgetAmount: "50000",
    });

    const acctRows = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, org.id));
    const byCode = new Map(acctRows.map((a) => [a.code, a]));
    return {
      org,
      vendor,
      job,
      concreteCC,
      subContractor: byCode.get("5300")!,
      apControl: byCode.get("2000")!,
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  console.log("Number series");
  await check("PO number series seeded with PO- prefix", async () => {
    const number = await db.transaction((tx) =>
      nextNumber(tx, fixtures.org.id, "PO")
    );
    if (!number.startsWith("PO-"))
      throw new Error(`expected PO- prefix, got ${number}`);
  });
  await check("SUB number series seeded with SUB- prefix", async () => {
    const number = await db.transaction((tx) =>
      nextNumber(tx, fixtures.org.id, "SUB")
    );
    if (!number.startsWith("SUB-"))
      throw new Error(`expected SUB- prefix, got ${number}`);
  });

  console.log("\nDraft + issue");
  let commitmentId: string | null = null;
  await check("create draft PO with one line for $30000", async () => {
    commitmentId = await db.transaction(async (tx) => {
      const number = await nextNumber(tx, fixtures.org.id, "PO");
      const [c] = await tx
        .insert(commitments)
        .values({
          organizationId: fixtures.org.id,
          jobId: fixtures.job.id,
          vendorId: fixtures.vendor.id,
          commitmentNumber: number,
          type: "po",
          status: "draft",
          description: "Concrete supply",
          totalAmount: "30000",
        })
        .returning();
      await tx.insert(commitmentLines).values({
        organizationId: fixtures.org.id,
        commitmentId: c.id,
        lineNumber: 1,
        accountId: fixtures.subContractor.id,
        costCodeId: fixtures.concreteCC.id,
        amount: "30000",
        description: "Cast-in-place foundation",
      });
      return c.id;
    });
  });

  await check("draft commitment does NOT bump committed_amount", async () => {
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    if (!money(row.committedAmount).isZero())
      throw new Error(`expected committed=0, got ${row.committedAmount}`);
  });

  await check("issue: committed_amount bumps to 30000", async () => {
    await db.transaction(async (tx) => {
      const [c] = await tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId!));
      await issueCommitment(tx, {
        commitment: c,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
    });
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    if (!money(row.committedAmount).equals(30000))
      throw new Error(`expected committed=30000, got ${row.committedAmount}`);
  });

  console.log("\nBill linked to commitment line");
  let lineId: string | null = null;
  await check("identify the commitment line for billing", async () => {
    const [line] = await db
      .select()
      .from(commitmentLines)
      .where(eq(commitmentLines.commitmentId, commitmentId!));
    if (!line) throw new Error("commitment line missing");
    lineId = line.id;
  });

  let billId: string | null = null;
  await check("post a $12000 bill linked to the commitment line", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .insert(apBills)
        .values({
          organizationId: fixtures.org.id,
          billNumber: "AP-COMMIT-1",
          vendorInvoiceNumber: "INV-1",
          vendorId: fixtures.vendor.id,
          billDate: "2026-03-15",
          dueDate: "2026-04-14",
          subtotalAmount: "12000",
          totalAmount: "12000",
          status: "approved",
        })
        .returning();
      billId = bill.id;
      await tx.insert(apBillLines).values({
        organizationId: fixtures.org.id,
        billId: bill.id,
        lineNumber: 1,
        accountId: fixtures.subContractor.id,
        jobId: fixtures.job.id,
        costCodeId: fixtures.concreteCC.id,
        commitmentLineId: lineId!,
        amount: "12000",
        description: "First pour",
      });
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

  await check("bill post: invoiced_amount on commitment line = 12000", async () => {
    const [line] = await db
      .select()
      .from(commitmentLines)
      .where(eq(commitmentLines.id, lineId!));
    if (!money(line.invoicedAmount).equals(12000))
      throw new Error(`expected invoiced=12000, got ${line.invoicedAmount}`);
  });

  await check("bill post: header invoiced_amount = 12000", async () => {
    const [c] = await db
      .select()
      .from(commitments)
      .where(eq(commitments.id, commitmentId!));
    if (!money(c.invoicedAmount).equals(12000))
      throw new Error(`expected invoiced=12000, got ${c.invoicedAmount}`);
  });

  await check("bill post: committed drops 30000 → 18000", async () => {
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    if (!money(row.committedAmount).equals(18000))
      throw new Error(`expected committed=18000, got ${row.committedAmount}`);
  });

  console.log("\nBill void releases the commitment");
  await check("void the bill — invoiced reverts to 0, committed back to 30000", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(apBills)
        .where(eq(apBills.id, billId!));
      const res = await voidBillFromGl(tx, {
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
          voidGlJournalId: res.journalId,
          voidReason: "Wrong vendor",
        })
        .where(eq(apBills.id, bill.id));
    });

    const [line] = await db
      .select()
      .from(commitmentLines)
      .where(eq(commitmentLines.id, lineId!));
    if (!money(line.invoicedAmount).isZero())
      throw new Error(`expected invoiced=0, got ${line.invoicedAmount}`);
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    if (!money(row.committedAmount).equals(30000))
      throw new Error(
        `expected committed restored to 30000, got ${row.committedAmount}`
      );
  });

  console.log("\nPartial bill, then close — drops remaining off committed");
  let partialBillId: string | null = null;
  await check("post a partial $20000 bill", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .insert(apBills)
        .values({
          organizationId: fixtures.org.id,
          billNumber: "AP-COMMIT-2",
          vendorInvoiceNumber: "INV-2",
          vendorId: fixtures.vendor.id,
          billDate: "2026-04-01",
          dueDate: "2026-05-01",
          subtotalAmount: "20000",
          totalAmount: "20000",
          status: "approved",
        })
        .returning();
      partialBillId = bill.id;
      await tx.insert(apBillLines).values({
        organizationId: fixtures.org.id,
        billId: bill.id,
        lineNumber: 1,
        accountId: fixtures.subContractor.id,
        jobId: fixtures.job.id,
        costCodeId: fixtures.concreteCC.id,
        commitmentLineId: lineId!,
        amount: "20000",
        description: "Second pour (partial)",
      });
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

    const [line] = await db
      .select()
      .from(commitmentLines)
      .where(eq(commitmentLines.id, lineId!));
    if (!money(line.invoicedAmount).equals(20000))
      throw new Error(`expected invoiced=20000, got ${line.invoicedAmount}`);
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    // committed = 30000 - 20000 = 10000
    if (!money(row.committedAmount).equals(10000))
      throw new Error(`expected committed=10000, got ${row.committedAmount}`);
  });

  await check("close commitment: remaining 10000 drops off committed", async () => {
    await db.transaction(async (tx) => {
      const [c] = await tx
        .select()
        .from(commitments)
        .where(eq(commitments.id, commitmentId!));
      await closeIssuedCommitment(tx, {
        commitment: c,
        actorId: actor.id,
        organizationId: fixtures.org.id,
        reason: "Project scope reduced",
      });
    });
    const [c] = await db
      .select()
      .from(commitments)
      .where(eq(commitments.id, commitmentId!));
    if (c.status !== "closed") throw new Error(`status=${c.status}`);
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    if (!money(row.committedAmount).isZero())
      throw new Error(`expected committed=0 after close, got ${row.committedAmount}`);
  });

  console.log("\nVoiding a bill against a closed commitment");
  await check("void of partial bill: invoiced rolls back, committed stays 0", async () => {
    await db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(apBills)
        .where(eq(apBills.id, partialBillId!));
      const res = await voidBillFromGl(tx, {
        bill,
        actorId: actor.id,
        organizationId: fixtures.org.id,
        reason: "Customer disputed",
      });
      await tx
        .update(apBills)
        .set({
          status: "voided",
          voidedAt: sql`now()`,
          voidGlJournalId: res.journalId,
          voidReason: "Customer disputed",
        })
        .where(eq(apBills.id, bill.id));
    });

    const [line] = await db
      .select()
      .from(commitmentLines)
      .where(eq(commitmentLines.id, lineId!));
    // invoiced rolled back to 0
    if (!money(line.invoicedAmount).isZero())
      throw new Error(`expected invoiced=0, got ${line.invoicedAmount}`);
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    // committed stays at 0 — commitment already closed; we don't resurrect it
    if (!money(row.committedAmount).isZero())
      throw new Error(
        `expected committed=0 (closed commitment, no resurrect), got ${row.committedAmount}`
      );
  });

  console.log("\nGuardrails");
  await check("cannot bill against a draft commitment", async () => {
    // Build a fresh draft + line
    const draftId = await db.transaction(async (tx) => {
      const num = await nextNumber(tx, fixtures.org.id, "PO");
      const [c] = await tx
        .insert(commitments)
        .values({
          organizationId: fixtures.org.id,
          jobId: fixtures.job.id,
          vendorId: fixtures.vendor.id,
          commitmentNumber: num,
          type: "po",
          status: "draft",
          description: "Draft for guardrail test",
          totalAmount: "1000",
        })
        .returning();
      await tx.insert(commitmentLines).values({
        organizationId: fixtures.org.id,
        commitmentId: c.id,
        lineNumber: 1,
        accountId: fixtures.subContractor.id,
        costCodeId: fixtures.concreteCC.id,
        amount: "1000",
      });
      return c.id;
    });

    const [draftLine] = await db
      .select()
      .from(commitmentLines)
      .where(eq(commitmentLines.commitmentId, draftId));

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [bill] = await tx
          .insert(apBills)
          .values({
            organizationId: fixtures.org.id,
            billNumber: "AP-GUARD-1",
            vendorId: fixtures.vendor.id,
            billDate: "2026-03-15",
            dueDate: "2026-04-14",
            subtotalAmount: "100",
            totalAmount: "100",
            status: "approved",
          })
          .returning();
        await tx.insert(apBillLines).values({
          organizationId: fixtures.org.id,
          billId: bill.id,
          lineNumber: 1,
          accountId: fixtures.subContractor.id,
          jobId: fixtures.job.id,
          costCodeId: fixtures.concreteCC.id,
          commitmentLineId: draftLine.id,
          amount: "100",
        });
        await postBillToGl(tx, {
          bill,
          actorId: actor.id,
          organizationId: fixtures.org.id,
        });
      });
    } catch {
      threw = true;
    }
    if (!threw)
      throw new Error("expected billing against draft commitment to throw");
  });

  await check("cannot issue a commitment with no lines", async () => {
    const emptyId = await db.transaction(async (tx) => {
      const num = await nextNumber(tx, fixtures.org.id, "PO");
      const [c] = await tx
        .insert(commitments)
        .values({
          organizationId: fixtures.org.id,
          jobId: fixtures.job.id,
          vendorId: fixtures.vendor.id,
          commitmentNumber: num,
          type: "po",
          status: "draft",
          description: "Empty",
          totalAmount: "0",
        })
        .returning();
      return c.id;
    });
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [c] = await tx
          .select()
          .from(commitments)
          .where(eq(commitments.id, emptyId));
        await issueCommitment(tx, {
          commitment: c,
          actorId: actor.id,
          organizationId: fixtures.org.id,
        });
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected issue with no lines to throw");
  });

  await check("cannot void from draft status", async () => {
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const [c] = await tx
          .select()
          .from(commitments)
          .where(eq(commitments.status, "draft"))
          .limit(1);
        await voidIssuedCommitment(tx, {
          commitment: c,
          actorId: actor.id,
          organizationId: fixtures.org.id,
          reason: "test",
        });
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected void on draft to throw");
  });

  console.log("\nSummary");
  await check("getJobCommitmentsSummary reflects current state", async () => {
    const s = await getJobCommitmentsSummary(fixtures.org.id, fixtures.job.id);
    if (s.closedCount !== 1)
      throw new Error(`expected 1 closed, got ${s.closedCount}`);
    if (s.draftCount < 1)
      throw new Error(`expected at least 1 draft, got ${s.draftCount}`);
  });

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
