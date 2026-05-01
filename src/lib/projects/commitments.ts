import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  commitmentLines,
  commitments,
  costCodes,
  jobCostCodes,
  jobs,
  type Commitment,
  type CommitmentLine,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { money, sumMoney, toDbMoney } from "@/lib/money";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Commitment lifecycle helpers.
 *
 * Issue: bumps committed_amount on each (job, cost_code) row by
 *   line.amount. Upserts a job_cost_codes row if none exists.
 *
 * Close / Void: drops the REMAINING (amount - invoiced_amount) off
 *   committed_amount. The invoiced portion is already in actuals (via
 *   GL posting); the un-invoiced remainder is the bit we admit we won't
 *   spend. close() and void() differ only in metadata (close_reason vs.
 *   void_reason, who can do them).
 *
 * Bill consume / reverse: called from lib/ap/posting.ts when a bill
 *   line linked to a commitment is posted/voided. Moves money from
 *   committed → invoiced (post) or back (void).
 *
 * All helpers are designed to run inside a caller's transaction.
 */

export async function issueCommitment(
  tx: Tx,
  opts: {
    commitment: Commitment;
    actorId: string | null;
    organizationId: string;
  }
): Promise<{ committedDelta: string; lineCount: number }> {
  const { commitment, actorId, organizationId } = opts;

  if (commitment.status !== "draft") {
    throw new Error(
      `Cannot issue commitment ${commitment.commitmentNumber} from status '${commitment.status}'.`
    );
  }

  // Lock job + verify open
  const [job] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, commitment.jobId),
        eq(jobs.organizationId, organizationId)
      )
    )
    .for("update");
  if (!job) throw new Error("Job not found.");
  if (job.status === "closed") {
    throw new Error("Cannot issue a commitment against a closed job.");
  }

  const lines = await tx
    .select()
    .from(commitmentLines)
    .where(eq(commitmentLines.commitmentId, commitment.id))
    .orderBy(commitmentLines.lineNumber);
  if (lines.length === 0) {
    throw new Error("Cannot issue a commitment with no lines.");
  }

  for (const line of lines) {
    await bumpCommitted(tx, organizationId, commitment.jobId, line.costCodeId, line.amount);
  }

  await tx
    .update(commitments)
    .set({
      status: "issued",
      issuedAt: sql`now()`,
      issuedBy: actorId,
      updatedAt: sql`now()`,
    })
    .where(eq(commitments.id, commitment.id));

  await writeAudit(
    {
      organizationId,
      actorId,
      event: "commitment.issued",
      entityType: "commitment",
      entityId: commitment.id,
      metadata: {
        commitmentNumber: commitment.commitmentNumber,
        type: commitment.type,
        jobId: commitment.jobId,
        totalAmount: commitment.totalAmount,
        lineCount: lines.length,
      },
    },
    tx
  );

  return {
    committedDelta: commitment.totalAmount,
    lineCount: lines.length,
  };
}

export async function closeIssuedCommitment(
  tx: Tx,
  opts: {
    commitment: Commitment;
    actorId: string | null;
    organizationId: string;
    reason?: string;
  }
): Promise<{ remainingDropped: string }> {
  return statusOff(tx, opts, "closed");
}

export async function voidIssuedCommitment(
  tx: Tx,
  opts: {
    commitment: Commitment;
    actorId: string | null;
    organizationId: string;
    reason: string;
  }
): Promise<{ remainingDropped: string }> {
  return statusOff(tx, opts, "voided");
}

async function statusOff(
  tx: Tx,
  opts: {
    commitment: Commitment;
    actorId: string | null;
    organizationId: string;
    reason?: string;
  },
  to: "closed" | "voided"
): Promise<{ remainingDropped: string }> {
  const { commitment, actorId, organizationId, reason } = opts;

  if (commitment.status !== "issued") {
    throw new Error(
      `Can only ${to === "closed" ? "close" : "void"} an issued commitment (this one is ${commitment.status}).`
    );
  }
  if (to === "voided" && !reason?.trim()) {
    throw new Error("Void reason is required.");
  }

  const lines = await tx
    .select()
    .from(commitmentLines)
    .where(eq(commitmentLines.commitmentId, commitment.id))
    .orderBy(commitmentLines.lineNumber);

  let totalDropped = money(0);
  for (const line of lines) {
    const remaining = money(line.amount).minus(money(line.invoicedAmount));
    if (remaining.isZero()) continue;
    await drainCommitted(
      tx,
      organizationId,
      commitment.jobId,
      line.costCodeId,
      remaining
    );
    totalDropped = totalDropped.plus(remaining);
  }

  const update: Record<string, unknown> = {
    status: to,
    updatedAt: sql`now()`,
  };
  if (to === "closed") {
    update.closedAt = sql`now()`;
    update.closedBy = actorId;
    if (reason) update.closeReason = reason;
  } else {
    update.voidedAt = sql`now()`;
    update.voidedBy = actorId;
    update.voidReason = reason;
  }
  await tx.update(commitments).set(update).where(eq(commitments.id, commitment.id));

  await writeAudit(
    {
      organizationId,
      actorId,
      event: to === "closed" ? "commitment.closed" : "commitment.voided",
      entityType: "commitment",
      entityId: commitment.id,
      metadata: {
        commitmentNumber: commitment.commitmentNumber,
        reason: reason ?? null,
        remainingDropped: totalDropped.toFixed(4),
        lineCount: lines.length,
      },
    },
    tx
  );

  return { remainingDropped: totalDropped.toFixed(4) };
}

/**
 * Called from AP bill posting when a bill line is linked to a
 * commitment line. Increments invoiced_amount on the commitment +
 * line and drops committed_amount on the matching job_cost_code by
 * the bill amount (only if the parent commitment is still issued —
 * if it's been closed/voided we still record invoiced for audit but
 * skip the committed math since committed already went to 0).
 */
export async function consumeCommitmentLineForBill(
  tx: Tx,
  opts: {
    commitmentLineId: string;
    organizationId: string;
    amount: string;
  }
): Promise<{
  commitmentId: string;
  status: Commitment["status"];
  prevInvoiced: string;
  newInvoiced: string;
}> {
  const { commitmentLineId, organizationId, amount } = opts;

  // Load + lock the line
  const [line] = await tx
    .select()
    .from(commitmentLines)
    .where(
      and(
        eq(commitmentLines.id, commitmentLineId),
        eq(commitmentLines.organizationId, organizationId)
      )
    )
    .for("update");
  if (!line) throw new Error("Commitment line not found.");

  const [parent] = await tx
    .select()
    .from(commitments)
    .where(eq(commitments.id, line.commitmentId))
    .for("update");
  if (!parent) throw new Error("Parent commitment missing.");
  if (parent.status === "draft") {
    throw new Error(
      `Cannot bill against a draft commitment (${parent.commitmentNumber}). Issue it first.`
    );
  }

  const prevInvoiced = line.invoicedAmount;
  const newInvoiced = money(prevInvoiced).plus(money(amount));

  // Update line
  await tx
    .update(commitmentLines)
    .set({
      invoicedAmount: toDbMoney(newInvoiced),
      updatedAt: sql`now()`,
    })
    .where(eq(commitmentLines.id, line.id));

  // Update header total invoiced
  await tx
    .update(commitments)
    .set({
      invoicedAmount: toDbMoney(money(parent.invoicedAmount).plus(money(amount))),
      updatedAt: sql`now()`,
    })
    .where(eq(commitments.id, parent.id));

  // Drop committed_amount on the corresponding job_cost_code, but only
  // while the commitment is still 'issued'. Once closed/voided, committed
  // already reflects the drop.
  if (parent.status === "issued") {
    await drainCommitted(
      tx,
      organizationId,
      parent.jobId,
      line.costCodeId,
      money(amount)
    );
  }

  return {
    commitmentId: parent.id,
    status: parent.status,
    prevInvoiced,
    newInvoiced: newInvoiced.toFixed(4),
  };
}

/**
 * Reverse of `consumeCommitmentLineForBill`. Called when an AP bill
 * is voided. Decrements invoiced_amount and restores committed_amount
 * if the commitment is still issued (otherwise skip — the committed
 * bucket is already drained on close/void and we don't want to
 * resurrect it).
 */
export async function releaseCommitmentLineFromBill(
  tx: Tx,
  opts: {
    commitmentLineId: string;
    organizationId: string;
    amount: string;
  }
): Promise<{ commitmentId: string; status: Commitment["status"] }> {
  const { commitmentLineId, organizationId, amount } = opts;

  const [line] = await tx
    .select()
    .from(commitmentLines)
    .where(
      and(
        eq(commitmentLines.id, commitmentLineId),
        eq(commitmentLines.organizationId, organizationId)
      )
    )
    .for("update");
  if (!line) throw new Error("Commitment line not found.");

  const [parent] = await tx
    .select()
    .from(commitments)
    .where(eq(commitments.id, line.commitmentId))
    .for("update");
  if (!parent) throw new Error("Parent commitment missing.");

  await tx
    .update(commitmentLines)
    .set({
      invoicedAmount: toDbMoney(
        money(line.invoicedAmount).minus(money(amount))
      ),
      updatedAt: sql`now()`,
    })
    .where(eq(commitmentLines.id, line.id));

  await tx
    .update(commitments)
    .set({
      invoicedAmount: toDbMoney(
        money(parent.invoicedAmount).minus(money(amount))
      ),
      updatedAt: sql`now()`,
    })
    .where(eq(commitments.id, parent.id));

  if (parent.status === "issued") {
    await bumpCommitted(
      tx,
      organizationId,
      parent.jobId,
      line.costCodeId,
      amount
    );
  }

  return { commitmentId: parent.id, status: parent.status };
}

// ---------------------------------------------------------------------------
// Internal helpers — committed_amount upsert/drain
// ---------------------------------------------------------------------------

async function bumpCommitted(
  tx: Tx,
  organizationId: string,
  jobId: string,
  costCodeId: string,
  amount: string | number | ReturnType<typeof money>
): Promise<void> {
  const delta = money(amount);
  const [existing] = await tx
    .select()
    .from(jobCostCodes)
    .where(
      and(
        eq(jobCostCodes.organizationId, organizationId),
        eq(jobCostCodes.jobId, jobId),
        eq(jobCostCodes.costCodeId, costCodeId)
      )
    )
    .for("update");
  if (existing) {
    await tx
      .update(jobCostCodes)
      .set({
        committedAmount: toDbMoney(money(existing.committedAmount).plus(delta)),
        updatedAt: sql`now()`,
      })
      .where(eq(jobCostCodes.id, existing.id));
  } else {
    await tx.insert(jobCostCodes).values({
      organizationId,
      jobId,
      costCodeId,
      budgetAmount: "0",
      committedAmount: toDbMoney(delta),
    });
  }
}

async function drainCommitted(
  tx: Tx,
  organizationId: string,
  jobId: string,
  costCodeId: string,
  amount: string | number | ReturnType<typeof money>
): Promise<void> {
  const delta = money(amount);
  const [existing] = await tx
    .select()
    .from(jobCostCodes)
    .where(
      and(
        eq(jobCostCodes.organizationId, organizationId),
        eq(jobCostCodes.jobId, jobId),
        eq(jobCostCodes.costCodeId, costCodeId)
      )
    )
    .for("update");
  if (!existing) return; // nothing to drain
  await tx
    .update(jobCostCodes)
    .set({
      committedAmount: toDbMoney(money(existing.committedAmount).minus(delta)),
      updatedAt: sql`now()`,
    })
    .where(eq(jobCostCodes.id, existing.id));
}

// ---------------------------------------------------------------------------
// Read-side helpers
// ---------------------------------------------------------------------------

/**
 * Per-job commitment summary. Used on /jobs/[id] header strip.
 */
export type JobCommitmentsSummary = {
  jobId: string;
  totalCount: number;
  draftCount: number;
  issuedCount: number;
  closedCount: number;
  voidedCount: number;
  totalCommitted: string; // sum of total_amount over issued commitments
  totalInvoiced: string;  // sum of invoiced_amount over issued commitments
  totalRemaining: string; // committed - invoiced (open future spend)
};

export async function getJobCommitmentsSummary(
  organizationId: string,
  jobId: string
): Promise<JobCommitmentsSummary> {
  const rows = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.organizationId, organizationId),
        eq(commitments.jobId, jobId)
      )
    );

  let draftCount = 0,
    issuedCount = 0,
    closedCount = 0,
    voidedCount = 0;
  const issuedTotals: string[] = [];
  const issuedInvoiced: string[] = [];
  for (const c of rows) {
    switch (c.status) {
      case "draft":
        draftCount++;
        break;
      case "issued":
        issuedCount++;
        issuedTotals.push(c.totalAmount);
        issuedInvoiced.push(c.invoicedAmount);
        break;
      case "closed":
        closedCount++;
        break;
      case "voided":
        voidedCount++;
        break;
    }
  }
  const totalCommitted = sumMoney(issuedTotals);
  const totalInvoiced = sumMoney(issuedInvoiced);
  return {
    jobId,
    totalCount: rows.length,
    draftCount,
    issuedCount,
    closedCount,
    voidedCount,
    totalCommitted: totalCommitted.toFixed(4),
    totalInvoiced: totalInvoiced.toFixed(4),
    totalRemaining: totalCommitted.minus(totalInvoiced).toFixed(4),
  };
}

/**
 * Pull lines + cost-code labels for a single commitment. Used by UI.
 */
export async function getCommitmentLinesWithCostCodes(
  commitmentId: string
): Promise<
  Array<{
    line: CommitmentLine;
    costCode: { id: string; code: string; name: string };
  }>
> {
  const rows = await db
    .select({
      line: commitmentLines,
      costCodeId: costCodes.id,
      costCodeCode: costCodes.code,
      costCodeName: costCodes.name,
    })
    .from(commitmentLines)
    .innerJoin(costCodes, eq(costCodes.id, commitmentLines.costCodeId))
    .where(eq(commitmentLines.commitmentId, commitmentId))
    .orderBy(commitmentLines.lineNumber);

  return rows.map((r) => ({
    line: r.line,
    costCode: {
      id: r.costCodeId,
      code: r.costCodeCode,
      name: r.costCodeName,
    },
  }));
}
