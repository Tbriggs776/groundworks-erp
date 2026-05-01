import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  changeOrderLines,
  changeOrders,
  costCodes,
  jobCostCodes,
  jobs,
  type ChangeOrder,
  type ChangeOrderLine,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { money, sumMoney, toDbMoney } from "@/lib/money";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Change-order execution + void.
 *
 * `executeChangeOrder` is the heart of the module: when an approved CO
 * is executed, it
 *   1. Bumps jobs.contractAmount by contractAdjustment (signed)
 *   2. For each line: adds line.amount to job_cost_codes.budgetAmount
 *      for that (job, cost_code). If no row exists, inserts a fresh one.
 *
 * `voidExecutedChangeOrder` reverses #1 and #2 atomically. Budget rows
 * created by execution are not auto-deleted on void — they remain at
 * whatever budget they have after the reversal (often 0 or back to the
 * previous baseline). Manual cleanup is up to the PM.
 *
 * Both run inside the caller's transaction so all-or-nothing semantics
 * pair correctly with the change_orders.status update + audit row.
 */

export async function executeChangeOrder(
  tx: Tx,
  opts: {
    co: ChangeOrder;
    actorId: string | null;
    organizationId: string;
  }
): Promise<{
  contractAmountBefore: string;
  contractAmountAfter: string;
  budgetDeltas: Array<{ costCodeId: string; delta: string; isNew: boolean }>;
}> {
  const { co, actorId, organizationId } = opts;

  if (co.status !== "approved") {
    throw new Error(
      `Cannot execute change order ${co.coNumber} from status '${co.status}'. Must be 'approved'.`
    );
  }

  // Lock the job row + read current contract amount
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, co.jobId), eq(jobs.organizationId, organizationId)))
    .for("update");
  if (!job) throw new Error("Job not found.");
  if (job.status === "closed") {
    throw new Error("Cannot execute a change order against a closed job.");
  }

  // Bump contract amount
  const contractBefore = money(job.contractAmount);
  const contractAfter = contractBefore.plus(money(co.contractAdjustment));
  await tx
    .update(jobs)
    .set({
      contractAmount: toDbMoney(contractAfter),
      updatedAt: sql`now()`,
    })
    .where(eq(jobs.id, co.jobId));

  // Pull lines
  const lines = await tx
    .select()
    .from(changeOrderLines)
    .where(eq(changeOrderLines.changeOrderId, co.id))
    .orderBy(changeOrderLines.lineNumber);

  const budgetDeltas: Array<{
    costCodeId: string;
    delta: string;
    isNew: boolean;
  }> = [];

  for (const line of lines) {
    // Upsert into job_cost_codes
    const [existing] = await tx
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.organizationId, organizationId),
          eq(jobCostCodes.jobId, co.jobId),
          eq(jobCostCodes.costCodeId, line.costCodeId)
        )
      )
      .for("update");

    if (existing) {
      const newBudget = money(existing.budgetAmount).plus(money(line.amount));
      await tx
        .update(jobCostCodes)
        .set({
          budgetAmount: toDbMoney(newBudget),
          updatedAt: sql`now()`,
        })
        .where(eq(jobCostCodes.id, existing.id));
      budgetDeltas.push({
        costCodeId: line.costCodeId,
        delta: toDbMoney(line.amount),
        isNew: false,
      });
    } else {
      await tx.insert(jobCostCodes).values({
        organizationId,
        jobId: co.jobId,
        costCodeId: line.costCodeId,
        budgetAmount: toDbMoney(line.amount),
        notes: `From CO ${co.coNumber}`,
      });
      budgetDeltas.push({
        costCodeId: line.costCodeId,
        delta: toDbMoney(line.amount),
        isNew: true,
      });
    }
  }

  // Mark CO executed
  await tx
    .update(changeOrders)
    .set({
      status: "executed",
      executedAt: sql`now()`,
      executedBy: actorId,
      updatedAt: sql`now()`,
    })
    .where(eq(changeOrders.id, co.id));

  await writeAudit(
    {
      organizationId,
      actorId,
      event: "change_order.executed",
      entityType: "change_order",
      entityId: co.id,
      metadata: {
        coNumber: co.coNumber,
        jobId: co.jobId,
        contractAdjustment: co.contractAdjustment,
        contractBefore: toDbMoney(contractBefore),
        contractAfter: toDbMoney(contractAfter),
        lineCount: lines.length,
      },
    },
    tx
  );

  return {
    contractAmountBefore: toDbMoney(contractBefore),
    contractAmountAfter: toDbMoney(contractAfter),
    budgetDeltas,
  };
}

export async function voidExecutedChangeOrder(
  tx: Tx,
  opts: {
    co: ChangeOrder;
    actorId: string | null;
    organizationId: string;
    reason: string;
  }
): Promise<{
  contractAmountBefore: string;
  contractAmountAfter: string;
}> {
  const { co, actorId, organizationId, reason } = opts;

  if (co.status !== "executed") {
    throw new Error(
      `Cannot void from status '${co.status}'. Only executed change orders can be voided.`
    );
  }

  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, co.jobId), eq(jobs.organizationId, organizationId)))
    .for("update");
  if (!job) throw new Error("Job not found.");

  // Reverse contract bump
  const contractBefore = money(job.contractAmount);
  const contractAfter = contractBefore.minus(money(co.contractAdjustment));
  await tx
    .update(jobs)
    .set({
      contractAmount: toDbMoney(contractAfter),
      updatedAt: sql`now()`,
    })
    .where(eq(jobs.id, co.jobId));

  // Reverse line budgets — subtract the same delta we added on execute.
  const lines = await tx
    .select()
    .from(changeOrderLines)
    .where(eq(changeOrderLines.changeOrderId, co.id))
    .orderBy(changeOrderLines.lineNumber);

  for (const line of lines) {
    const [existing] = await tx
      .select()
      .from(jobCostCodes)
      .where(
        and(
          eq(jobCostCodes.organizationId, organizationId),
          eq(jobCostCodes.jobId, co.jobId),
          eq(jobCostCodes.costCodeId, line.costCodeId)
        )
      )
      .for("update");
    if (!existing) {
      // Should never happen — we created or updated this row on execute.
      // Skip rather than throw: the void should still complete.
      continue;
    }
    const newBudget = money(existing.budgetAmount).minus(money(line.amount));
    await tx
      .update(jobCostCodes)
      .set({
        budgetAmount: toDbMoney(newBudget),
        updatedAt: sql`now()`,
      })
      .where(eq(jobCostCodes.id, existing.id));
  }

  // Mark CO voided
  await tx
    .update(changeOrders)
    .set({
      status: "voided",
      voidedAt: sql`now()`,
      voidedBy: actorId,
      voidReason: reason,
      updatedAt: sql`now()`,
    })
    .where(eq(changeOrders.id, co.id));

  await writeAudit(
    {
      organizationId,
      actorId,
      event: "change_order.voided",
      entityType: "change_order",
      entityId: co.id,
      metadata: {
        coNumber: co.coNumber,
        jobId: co.jobId,
        reason,
        contractBefore: toDbMoney(contractBefore),
        contractAfter: toDbMoney(contractAfter),
        lineCount: lines.length,
      },
    },
    tx
  );

  return {
    contractAmountBefore: toDbMoney(contractBefore),
    contractAmountAfter: toDbMoney(contractAfter),
  };
}

// ---------------------------------------------------------------------------
// Read-side helpers used by UI + cross-job report
// ---------------------------------------------------------------------------

/**
 * Per-job change-order summary. Used on the job detail page to show
 * "X approved/executed COs, $Y delta" in the header card.
 */
export type JobChangeOrderSummary = {
  jobId: string;
  totalCount: number;
  executedCount: number;
  pendingCount: number;
  rejectedCount: number;
  voidedCount: number;
  // Net approved + executed contract delta — what's actually "live" against
  // the job. Voided + draft + pending excluded.
  liveContractDelta: string;
  // Sum of contractAdjustment across executed COs
  executedContractDelta: string;
};

export async function getJobChangeOrderSummary(
  organizationId: string,
  jobId: string
): Promise<JobChangeOrderSummary> {
  const rows = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.organizationId, organizationId),
        eq(changeOrders.jobId, jobId)
      )
    );

  let executedCount = 0;
  let pendingCount = 0;
  let rejectedCount = 0;
  let voidedCount = 0;
  const liveAdjustments: string[] = [];
  const executedAdjustments: string[] = [];
  for (const r of rows) {
    switch (r.status) {
      case "draft":
      case "pending_approval":
        pendingCount++;
        break;
      case "rejected":
        rejectedCount++;
        break;
      case "approved":
        // Approved-but-not-executed contributes to the "live delta"
        // because it's expected to apply (used for forecasting).
        liveAdjustments.push(r.contractAdjustment);
        break;
      case "executed":
        executedCount++;
        liveAdjustments.push(r.contractAdjustment);
        executedAdjustments.push(r.contractAdjustment);
        break;
      case "voided":
        voidedCount++;
        break;
    }
  }

  return {
    jobId,
    totalCount: rows.length,
    executedCount,
    pendingCount,
    rejectedCount,
    voidedCount,
    liveContractDelta: sumMoney(liveAdjustments).toFixed(4),
    executedContractDelta: sumMoney(executedAdjustments).toFixed(4),
  };
}

/**
 * Pull the lines of a change order joined to the cost code (for UI
 * display). Returns lines ordered by lineNumber.
 */
export async function getChangeOrderLinesWithCostCodes(
  changeOrderId: string
): Promise<
  Array<{
    line: ChangeOrderLine;
    costCode: { id: string; code: string; name: string };
  }>
> {
  const rows = await db
    .select({
      line: changeOrderLines,
      costCodeId: costCodes.id,
      costCodeCode: costCodes.code,
      costCodeName: costCodes.name,
    })
    .from(changeOrderLines)
    .innerJoin(costCodes, eq(costCodes.id, changeOrderLines.costCodeId))
    .where(eq(changeOrderLines.changeOrderId, changeOrderId))
    .orderBy(changeOrderLines.lineNumber);

  return rows.map((r) => ({
    line: r.line,
    costCode: {
      id: r.costCodeId,
      code: r.costCodeCode,
      name: r.costCodeName,
    },
  }));
}
