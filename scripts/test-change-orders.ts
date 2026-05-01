/**
 * End-to-end verification of Tier 2.4 — Change Orders.
 *
 * Exercises:
 *   - State machine: draft → pending_approval → approved | rejected → ...
 *   - Approval routing against change_order scope tier
 *   - Execution: contract amount + budget bumps applied atomically
 *   - Void: reverses contract + budget, audit logged
 *   - getJobChangeOrderSummary: counts and net deltas across statuses
 *
 *   npx tsx scripts/test-change-orders.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  approvalThresholds,
  changeOrderLines,
  changeOrders,
  costCodes,
  customers,
  jobCostCodes,
  jobs,
  memberships,
  organizations,
  profiles,
} from "../src/lib/db/schema";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";
import {
  syncCostCodeDimensionValue,
  syncJobDimensionValue,
} from "../src/lib/projects/dimension-sync";
import {
  resolveApprovalRouting,
  canApproveAtRole,
} from "../src/lib/ap/approval";
import {
  executeChangeOrder,
  getJobChangeOrderSummary,
  voidExecutedChangeOrder,
} from "../src/lib/projects/change-orders";
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
  const testSlug = `co-test-${Date.now()}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "co-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "CO Test", slug: testSlug, baseCurrency: "USD" })
      .returning();
    await tx.insert(memberships).values({
      organizationId: org.id,
      userId: actor.id,
      role: "owner",
    });
    await seedOrganizationDefaults(tx, org.id, {
      includeContractorCoa: false,
      includeCsiCostCodes: false,
    });
    await generateFiscalYear(tx, {
      organizationId: org.id,
      startDate: "2026-01-01",
      yearLabel: "FY2026",
    });

    const [customer] = await tx
      .insert(customers)
      .values({
        organizationId: org.id,
        code: "CUST-001",
        name: "Test Customer",
        customerType: "commercial",
      })
      .returning();

    // Cost codes
    const concreteDim = await syncCostCodeDimensionValue(tx, org.id, {
      code: "03-30-00",
      name: "Cast-in-Place Concrete",
    });
    const newDim = await syncCostCodeDimensionValue(tx, org.id, {
      code: "26-00-00",
      name: "Electrical",
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
    const [newCC] = await tx
      .insert(costCodes)
      .values({
        organizationId: org.id,
        code: "26-00-00",
        name: "Electrical",
        costType: "subcontractor",
        dimensionValueId: newDim,
      })
      .returning();

    // Job
    const jobDim = await syncJobDimensionValue(tx, org.id, {
      code: "J-200",
      name: "Office Build-Out",
    });
    const [job] = await tx
      .insert(jobs)
      .values({
        organizationId: org.id,
        code: "J-200",
        name: "Office Build-Out",
        customerId: customer.id,
        contractAmount: "200000",
        status: "active",
        dimensionValueId: jobDim,
      })
      .returning();

    // Initial budget on concrete only — newCC will be added via CO
    await tx.insert(jobCostCodes).values({
      organizationId: org.id,
      jobId: job.id,
      costCodeId: concreteCC.id,
      budgetAmount: "100000",
    });

    return { org, job, concreteCC, newCC };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  console.log("Default change_order approval threshold seeded");
  await check("default scope=change_order tier seeded by org-defaults", async () => {
    const r = await resolveApprovalRouting(
      fixtures.org.id,
      "change_order",
      "1000"
    );
    if (r.fallback) throw new Error("expected seeded tier, got fallback");
    if (r.requiredRole !== "admin")
      throw new Error(`expected admin, got ${r.requiredRole}`);
  });

  await check("threshold tiers can be configured for change_order", async () => {
    await db.transaction(async (tx) => {
      // Deactivate the default scope=change_order tier
      await tx
        .update(approvalThresholds)
        .set({ isActive: false })
        .where(
          and(
            eq(approvalThresholds.organizationId, fixtures.org.id),
            eq(approvalThresholds.scope, "change_order"),
            eq(approvalThresholds.tierName, "Default")
          )
        );
      await tx.insert(approvalThresholds).values([
        {
          organizationId: fixtures.org.id,
          scope: "change_order",
          tierName: "Small",
          minAmount: "0",
          maxAmount: "5000",
          requiredRole: "pm",
          sortOrder: 10,
        },
        {
          organizationId: fixtures.org.id,
          scope: "change_order",
          tierName: "Medium",
          minAmount: "5000",
          maxAmount: "50000",
          requiredRole: "admin",
          sortOrder: 20,
        },
        {
          organizationId: fixtures.org.id,
          scope: "change_order",
          tierName: "Large",
          minAmount: "50000",
          maxAmount: null,
          requiredRole: "owner",
          sortOrder: 30,
        },
      ]);
    });
    const r1 = await resolveApprovalRouting(
      fixtures.org.id,
      "change_order",
      "2000"
    );
    if (r1.requiredRole !== "pm")
      throw new Error(`2000 should route to pm, got ${r1.requiredRole}`);
    const r2 = await resolveApprovalRouting(
      fixtures.org.id,
      "change_order",
      "20000"
    );
    if (r2.requiredRole !== "admin")
      throw new Error(`20000 should route to admin, got ${r2.requiredRole}`);
    const r3 = await resolveApprovalRouting(
      fixtures.org.id,
      "change_order",
      "100000"
    );
    if (r3.requiredRole !== "owner")
      throw new Error(`100000 should route to owner, got ${r3.requiredRole}`);
  });

  console.log("\nDraft + state machine");
  let coId: string | null = null;
  await check("create draft CO with two lines, CO number from CO series", async () => {
    coId = await db.transaction(async (tx) => {
      const coNumber = await nextNumber(tx, fixtures.org.id, "CO");
      if (!coNumber.startsWith("CO-"))
        throw new Error(`expected CO- prefix, got ${coNumber}`);

      const [row] = await tx
        .insert(changeOrders)
        .values({
          organizationId: fixtures.org.id,
          jobId: fixtures.job.id,
          coNumber,
          description: "Add scope: dedicated electrical room + concrete extension",
          contractAdjustment: "30000",
          scheduleAdjustmentDays: 14,
          status: "draft",
        })
        .returning();
      await tx.insert(changeOrderLines).values([
        {
          organizationId: fixtures.org.id,
          changeOrderId: row.id,
          lineNumber: 1,
          costCodeId: fixtures.concreteCC.id,
          amount: "10000",
          description: "Extra concrete for new room",
        },
        {
          organizationId: fixtures.org.id,
          changeOrderId: row.id,
          lineNumber: 2,
          costCodeId: fixtures.newCC.id,
          amount: "18000",
          description: "Electrical rough-in",
        },
      ]);
      return row.id;
    });
  });

  await check("submit draft → pending_approval; threshold linked", async () => {
    const routing = await resolveApprovalRouting(
      fixtures.org.id,
      "change_order",
      "30000"
    );
    if (routing.requiredRole !== "admin")
      throw new Error(`30000 should be admin tier`);
    await db
      .update(changeOrders)
      .set({
        status: "pending_approval",
        submittedAt: sql`now()`,
        submittedBy: actor.id,
        approvalThresholdId: routing.threshold?.id ?? null,
      })
      .where(eq(changeOrders.id, coId!));
    const [co] = await db
      .select()
      .from(changeOrders)
      .where(eq(changeOrders.id, coId!));
    if (co.status !== "pending_approval")
      throw new Error(`expected pending_approval, got ${co.status}`);
    if (!co.approvalThresholdId)
      throw new Error("expected approvalThresholdId set");
  });

  await check("rank check: pm cannot approve a 30000 CO (admin tier)", async () => {
    if (canApproveAtRole("pm", "admin"))
      throw new Error("pm should NOT outrank admin");
  });
  await check("rank check: admin can approve a 30000 CO", async () => {
    if (!canApproveAtRole("admin", "admin"))
      throw new Error("admin should meet admin");
  });

  await check("approve: pending_approval → approved", async () => {
    await db
      .update(changeOrders)
      .set({
        status: "approved",
        approvedAt: sql`now()`,
        approvedBy: actor.id,
      })
      .where(eq(changeOrders.id, coId!));
    const [co] = await db
      .select()
      .from(changeOrders)
      .where(eq(changeOrders.id, coId!));
    if (co.status !== "approved") throw new Error(`got ${co.status}`);
  });

  console.log("\nExecution — applies contract bump + budget bumps");
  await check("execute: contractAmount goes 200000 → 230000", async () => {
    await db.transaction(async (tx) => {
      const [co] = await tx
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.id, coId!));
      const r = await executeChangeOrder(tx, {
        co,
        actorId: actor.id,
        organizationId: fixtures.org.id,
      });
      if (!money(r.contractAmountAfter).equals(230000))
        throw new Error(
          `expected contractAfter=230000, got ${r.contractAmountAfter}`
        );
    });
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, fixtures.job.id));
    if (!money(job.contractAmount).equals(230000))
      throw new Error(`job.contractAmount=${job.contractAmount}`);
  });

  await check("execute: existing concrete budget bumped 100000 → 110000", async () => {
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    if (!money(row.budgetAmount).equals(110000))
      throw new Error(`expected concrete=110000, got ${row.budgetAmount}`);
  });

  await check("execute: new electrical row inserted with budget 18000", async () => {
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.newCC.id)
        )
      );
    if (!row) throw new Error("expected new electrical row to exist");
    if (!money(row.budgetAmount).equals(18000))
      throw new Error(`expected new=18000, got ${row.budgetAmount}`);
  });

  await check("CO status now executed", async () => {
    const [co] = await db
      .select()
      .from(changeOrders)
      .where(eq(changeOrders.id, coId!));
    if (co.status !== "executed") throw new Error(`got ${co.status}`);
    if (!co.executedAt) throw new Error("expected executedAt set");
  });

  console.log("\nSummary report");
  await check("summary: 1 executed, liveContractDelta=30000", async () => {
    const s = await getJobChangeOrderSummary(fixtures.org.id, fixtures.job.id);
    if (s.executedCount !== 1)
      throw new Error(`expected 1 executed, got ${s.executedCount}`);
    if (!money(s.liveContractDelta).equals(30000))
      throw new Error(`expected 30000, got ${s.liveContractDelta}`);
  });

  console.log("\nVoid — reverses contract + budgets");
  await check("void: contractAmount reverts 230000 → 200000", async () => {
    await db.transaction(async (tx) => {
      const [co] = await tx
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.id, coId!));
      const r = await voidExecutedChangeOrder(tx, {
        co,
        actorId: actor.id,
        organizationId: fixtures.org.id,
        reason: "Owner withdrew the change",
      });
      if (!money(r.contractAmountAfter).equals(200000))
        throw new Error(
          `expected contractAfter=200000, got ${r.contractAmountAfter}`
        );
    });
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, fixtures.job.id));
    if (!money(job.contractAmount).equals(200000))
      throw new Error(`expected 200000, got ${job.contractAmount}`);
  });

  await check("void: concrete budget reverts 110000 → 100000", async () => {
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.concreteCC.id)
        )
      );
    if (!money(row.budgetAmount).equals(100000))
      throw new Error(`expected 100000, got ${row.budgetAmount}`);
  });

  await check("void: electrical budget reverts 18000 → 0 (row stays)", async () => {
    const [row] = await db
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.jobId, fixtures.job.id),
          eq(jobCostCodes.costCodeId, fixtures.newCC.id)
        )
      );
    if (!row) throw new Error("electrical row should remain after void");
    if (!money(row.budgetAmount).isZero())
      throw new Error(`expected 0, got ${row.budgetAmount}`);
  });

  await check("CO status voided + voidReason captured", async () => {
    const [co] = await db
      .select()
      .from(changeOrders)
      .where(eq(changeOrders.id, coId!));
    if (co.status !== "voided") throw new Error(`got ${co.status}`);
    if (co.voidReason !== "Owner withdrew the change")
      throw new Error(`got reason=${co.voidReason}`);
  });

  console.log("\nGuardrails");
  await check("cannot execute a CO that's not approved", async () => {
    // Insert a draft CO
    const [draft] = await db
      .insert(changeOrders)
      .values({
        organizationId: fixtures.org.id,
        jobId: fixtures.job.id,
        coNumber: await db.transaction((tx) =>
          nextNumber(tx, fixtures.org.id, "CO")
        ),
        description: "Should not execute",
        contractAdjustment: "1000",
        status: "draft",
      })
      .returning();
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        await executeChangeOrder(tx, {
          co: draft,
          actorId: actor.id,
          organizationId: fixtures.org.id,
        });
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected execute on draft to throw");
  });

  await check("cannot void from non-executed status", async () => {
    const [draft] = await db
      .insert(changeOrders)
      .values({
        organizationId: fixtures.org.id,
        jobId: fixtures.job.id,
        coNumber: await db.transaction((tx) =>
          nextNumber(tx, fixtures.org.id, "CO")
        ),
        description: "Should not void from draft",
        contractAdjustment: "1000",
        status: "draft",
      })
      .returning();
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        await voidExecutedChangeOrder(tx, {
          co: draft,
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
