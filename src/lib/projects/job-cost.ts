import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  accounts,
  costCodes,
  glJournals,
  glLines,
  jobCostCodes,
  jobs,
} from "@/lib/db/schema";
import { money, type MoneyInput } from "@/lib/money";
import Decimal from "decimal.js";

/**
 * Job-cost reporting. The wedge: budget × committed × actual per
 * (job, cost_code), live from the GL.
 *
 * Sources of truth:
 *   - Budget    → job_cost_codes.budget_amount (set by PM, no GL hit)
 *   - Committed → job_cost_codes.committed_amount (will be populated by
 *                 the Commitments / PO module — for v1 it just reflects
 *                 whatever's in the column; default 0)
 *   - Actual    → live SUM(debit_local - credit_local) on gl_lines for
 *                 the (job, cost_code) pair, restricted to posted journals
 *                 only. Reversals net out automatically because the
 *                 reversing journal flips sides while keeping job/cost_code.
 *
 * We DO NOT denormalize actuals back to job_cost_codes.actual_amount; that
 * column is reserved for a possible future cache. The live query is fast
 * enough — gl_lines has org+account, journal+line, and journal indexes,
 * and a (job, cost_code) filter is selective in real datasets.
 *
 * Variance convention (cost variance):
 *   variance      = budget - actual           (positive = under budget)
 *   open_budget   = budget - committed - actual  (cash-style)
 *   percent_used  = (actual / budget) * 100   (null if budget = 0)
 *
 * The summary includes BOTH:
 *   - Cost-code rows with a budget (job_cost_codes), even if no actual yet
 *   - Cost-code rows with actuals but no budget (rogue costs — should be
 *     surfaced loudly so the PM can decide to add them to the budget or
 *     reclassify the GL entry)
 */

export type JobCostRow = {
  /** job_cost_codes row id, or null if this cost code has actuals but no budget yet */
  jobCostCodeId: string | null;
  costCodeId: string;
  costCode: string;
  costCodeName: string;
  costType: string;
  budget: string; // numeric(20,4)
  committed: string;
  actual: string;
  variance: string; // budget - actual
  openBudget: string; // budget - committed - actual
  /** null if budget = 0 (avoids divide-by-zero in the UI) */
  percentUsed: number | null;
  /** True when this row has actuals but no budget — flag for PM review */
  unbudgeted: boolean;
};

export type JobCostSummary = {
  jobId: string;
  jobCode: string;
  jobName: string;
  contractAmount: string;
  totalBudget: string;
  totalCommitted: string;
  totalActual: string;
  totalVariance: string;
  totalOpenBudget: string;
  /** Net of contractAmount - totalActual (gross profit at this point) */
  estimatedGrossProfit: string;
  /** Number of cost codes with actuals but no budget */
  unbudgetedCount: number;
  rows: JobCostRow[];
};

/**
 * Returns full job-cost summary for one job. Single round-trip:
 *   1. Pull job header
 *   2. LEFT JOIN job_cost_codes ↔ cost_codes ↔ aggregated gl_lines
 *      to get every code that has either a budget or actuals
 */
export async function getJobCostSummary(
  organizationId: string,
  jobId: string
): Promise<JobCostSummary | null> {
  const [job] = await db
    .select({
      id: jobs.id,
      code: jobs.code,
      name: jobs.name,
      contractAmount: jobs.contractAmount,
    })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)));
  if (!job) return null;

  // Aggregate actuals from gl_lines per cost code for this job.
  //
  // Status filter — IMPORTANT: include both 'posted' and 'reversed'.
  // When `reverseJournal` posts a reversing entry, it flips the ORIGINAL
  // journal's status from 'posted' to 'reversed' (see src/lib/gl/posting.ts).
  // Both journals have real ledger lines that must be counted: the
  // original line (now in a 'reversed'-status journal) and the reversal
  // line (in a 'posted' reversing journal). Filtering only 'posted' would
  // count the reversal but exclude the original, producing a phantom
  // negative for every voided document.
  const actualsRows = await db.execute<{
    cost_code_id: string;
    actual: string;
  }>(sql`
    SELECT
      gl.cost_code_id AS cost_code_id,
      COALESCE(SUM(gl.debit_local - gl.credit_local), 0)::numeric(20,4)::text AS actual
    FROM public.gl_lines gl
    INNER JOIN public.gl_journals gj
      ON gj.id = gl.journal_id
     AND gj.status IN ('posted', 'reversed')
    WHERE gl.organization_id = ${organizationId}
      AND gl.job_id = ${jobId}
      AND gl.cost_code_id IS NOT NULL
    GROUP BY gl.cost_code_id
  `);

  const actualByCostCode = new Map<string, string>();
  for (const r of actualsRows) {
    actualByCostCode.set(r.cost_code_id, r.actual);
  }

  // Pull all job_cost_codes rows joined to cost_codes (the budget set)
  const budgeted = await db
    .select({
      jcc: jobCostCodes,
      cc: costCodes,
    })
    .from(jobCostCodes)
    .innerJoin(costCodes, eq(costCodes.id, jobCostCodes.costCodeId))
    .where(
      and(
        eq(jobCostCodes.organizationId, organizationId),
        eq(jobCostCodes.jobId, jobId)
      )
    )
    .orderBy(asc(costCodes.code));

  const budgetedCostCodeIds = new Set(budgeted.map((b) => b.cc.id));

  // Find any unbudgeted cost codes — codes where actuals exist for this
  // job but no job_cost_codes row was set up.
  const unbudgetedCostCodeIds = Array.from(actualByCostCode.keys()).filter(
    (id) => !budgetedCostCodeIds.has(id)
  );

  let unbudgetedRows: Array<typeof costCodes.$inferSelect> = [];
  if (unbudgetedCostCodeIds.length > 0) {
    unbudgetedRows = await db
      .select()
      .from(costCodes)
      .where(
        and(
          eq(costCodes.organizationId, organizationId),
          inArray(costCodes.id, unbudgetedCostCodeIds)
        )
      )
      .orderBy(asc(costCodes.code));
  }

  const rows: JobCostRow[] = [];

  // 1. Budgeted rows
  for (const { jcc, cc } of budgeted) {
    const actual = actualByCostCode.get(cc.id) ?? "0";
    rows.push(buildRow({ jcc, cc, actual, unbudgeted: false }));
  }

  // 2. Unbudgeted rows (actual but no budget — surfaced to PM)
  for (const cc of unbudgetedRows) {
    const actual = actualByCostCode.get(cc.id) ?? "0";
    rows.push(buildRow({ jcc: null, cc, actual, unbudgeted: true }));
  }

  // Sort: budgeted rows first by code, then unbudgeted by code (already
  // mostly ordered above; resort to be deterministic across page loads).
  rows.sort((a, b) => {
    if (a.unbudgeted !== b.unbudgeted) return a.unbudgeted ? 1 : -1;
    return a.costCode.localeCompare(b.costCode);
  });

  // Roll up totals
  const totalBudget = sumDecimal(rows.map((r) => r.budget));
  const totalCommitted = sumDecimal(rows.map((r) => r.committed));
  const totalActual = sumDecimal(rows.map((r) => r.actual));
  const totalVariance = totalBudget.minus(totalActual);
  const totalOpenBudget = totalBudget.minus(totalCommitted).minus(totalActual);
  const contractAmount = money(job.contractAmount);
  const estimatedGrossProfit = contractAmount.minus(totalActual);

  return {
    jobId: job.id,
    jobCode: job.code,
    jobName: job.name,
    contractAmount: contractAmount.toFixed(4),
    totalBudget: totalBudget.toFixed(4),
    totalCommitted: totalCommitted.toFixed(4),
    totalActual: totalActual.toFixed(4),
    totalVariance: totalVariance.toFixed(4),
    totalOpenBudget: totalOpenBudget.toFixed(4),
    estimatedGrossProfit: estimatedGrossProfit.toFixed(4),
    unbudgetedCount: rows.filter((r) => r.unbudgeted).length,
    rows,
  };
}

/**
 * Cross-job summary — one row per job. Used by /reports/job-cost. Pulls
 * actuals in a single grouped query. Suitable for hundreds of jobs; if the
 * org grows past a few thousand active jobs, we'll add a status filter
 * and pagination.
 */
export type JobsCostRow = {
  jobId: string;
  jobCode: string;
  jobName: string;
  jobStatus: string;
  customerName: string | null;
  contractAmount: string;
  totalBudget: string;
  totalCommitted: string;
  totalActual: string;
  totalVariance: string;
  totalOpenBudget: string;
  estimatedGrossProfit: string;
  /** percent of budget used — null when no budget */
  percentUsed: number | null;
};

export async function getJobsCostSummary(
  organizationId: string,
  opts: { includeClosed?: boolean } = {}
): Promise<JobsCostRow[]> {
  // Aggregate actuals per job in one round trip. See note in
  // getJobCostSummary about why both 'posted' and 'reversed' must be
  // included — the original line of a voided journal lives in a
  // 'reversed'-status journal, the offsetting reversal line lives in a
  // 'posted'-status reversing journal, and they need to net to zero.
  const actualsRows = await db.execute<{
    job_id: string;
    actual: string;
  }>(sql`
    SELECT
      gl.job_id AS job_id,
      COALESCE(SUM(gl.debit_local - gl.credit_local), 0)::numeric(20,4)::text AS actual
    FROM public.gl_lines gl
    INNER JOIN public.gl_journals gj
      ON gj.id = gl.journal_id
     AND gj.status IN ('posted', 'reversed')
    WHERE gl.organization_id = ${organizationId}
      AND gl.job_id IS NOT NULL
    GROUP BY gl.job_id
  `);
  const actualByJob = new Map<string, string>();
  for (const r of actualsRows) actualByJob.set(r.job_id, r.actual);

  // Aggregate budget + committed per job from job_cost_codes
  const budgetRows = await db.execute<{
    job_id: string;
    total_budget: string;
    total_committed: string;
  }>(sql`
    SELECT
      jcc.job_id AS job_id,
      COALESCE(SUM(jcc.budget_amount), 0)::numeric(20,4)::text AS total_budget,
      COALESCE(SUM(jcc.committed_amount), 0)::numeric(20,4)::text AS total_committed
    FROM public.job_cost_codes jcc
    WHERE jcc.organization_id = ${organizationId}
    GROUP BY jcc.job_id
  `);
  const budgetByJob = new Map<
    string,
    { totalBudget: string; totalCommitted: string }
  >();
  for (const r of budgetRows) {
    budgetByJob.set(r.job_id, {
      totalBudget: r.total_budget,
      totalCommitted: r.total_committed,
    });
  }

  // Pull jobs (+ customer name)
  const jobRows = await db.execute<{
    id: string;
    code: string;
    name: string;
    status: string;
    contract_amount: string;
    customer_name: string | null;
  }>(sql`
    SELECT
      j.id,
      j.code,
      j.name,
      j.status,
      j.contract_amount::text AS contract_amount,
      c.name AS customer_name
    FROM public.jobs j
    LEFT JOIN public.customers c ON c.id = j.customer_id
    WHERE j.organization_id = ${organizationId}
      AND j.deleted_at IS NULL
      ${opts.includeClosed ? sql`` : sql`AND j.status <> 'closed'`}
    ORDER BY j.code ASC
  `);

  return jobRows.map((j) => {
    const actual = actualByJob.get(j.id) ?? "0";
    const budgetInfo = budgetByJob.get(j.id) ?? {
      totalBudget: "0",
      totalCommitted: "0",
    };
    const totalBudget = money(budgetInfo.totalBudget);
    const totalCommitted = money(budgetInfo.totalCommitted);
    const totalActual = money(actual);
    const variance = totalBudget.minus(totalActual);
    const openBudget = totalBudget.minus(totalCommitted).minus(totalActual);
    const contractAmount = money(j.contract_amount);
    const egp = contractAmount.minus(totalActual);
    const percentUsed = totalBudget.isZero()
      ? null
      : totalActual.dividedBy(totalBudget).times(100).toDecimalPlaces(2).toNumber();
    return {
      jobId: j.id,
      jobCode: j.code,
      jobName: j.name,
      jobStatus: j.status,
      customerName: j.customer_name,
      contractAmount: contractAmount.toFixed(4),
      totalBudget: totalBudget.toFixed(4),
      totalCommitted: totalCommitted.toFixed(4),
      totalActual: totalActual.toFixed(4),
      totalVariance: variance.toFixed(4),
      totalOpenBudget: openBudget.toFixed(4),
      estimatedGrossProfit: egp.toFixed(4),
      percentUsed,
    };
  });
}

/**
 * Drill-down detail: every gl_line for a (job, cost_code) pair on this org,
 * for posted journals only. Used by the cost-code drill-down page.
 */
export type JobCostDetailRow = {
  lineId: string;
  journalId: string;
  journalNumber: string;
  journalDate: string;
  source: string;
  description: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  net: string;
  memo: string | null;
};

export async function getJobCostDetail(
  organizationId: string,
  jobId: string,
  costCodeId: string | null
): Promise<JobCostDetailRow[]> {
  const rows = await db
    .select({
      lineId: glLines.id,
      journalId: glJournals.id,
      journalNumber: glJournals.journalNumber,
      journalDate: glJournals.journalDate,
      source: glJournals.source,
      description: glJournals.description,
      accountCode: accounts.code,
      accountName: accounts.name,
      debit: glLines.debitLocal,
      credit: glLines.creditLocal,
      memo: glLines.memo,
    })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .innerJoin(accounts, eq(accounts.id, glLines.accountId))
    .where(
      and(
        eq(glLines.organizationId, organizationId),
        eq(glLines.jobId, jobId),
        // Include both posted and reversed (see note in getJobCostSummary)
        or(eq(glJournals.status, "posted"), eq(glJournals.status, "reversed")),
        costCodeId === null
          ? isNull(glLines.costCodeId)
          : eq(glLines.costCodeId, costCodeId),
        // exclude null costCodeId rows when filtering to a specific cost code
        costCodeId === null ? sql`true` : isNotNull(glLines.costCodeId)
      )
    )
    .orderBy(asc(glJournals.journalDate), asc(glJournals.journalNumber));

  return rows.map((r) => {
    const debit = money(r.debit);
    const credit = money(r.credit);
    return {
      lineId: r.lineId,
      journalId: r.journalId,
      journalNumber: r.journalNumber,
      journalDate: r.journalDate,
      source: r.source,
      description: r.description,
      accountCode: r.accountCode,
      accountName: r.accountName,
      debit: debit.toFixed(4),
      credit: credit.toFixed(4),
      net: debit.minus(credit).toFixed(4),
      memo: r.memo,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildRow(opts: {
  jcc: typeof jobCostCodes.$inferSelect | null;
  cc: typeof costCodes.$inferSelect;
  actual: string;
  unbudgeted: boolean;
}): JobCostRow {
  const budget = money(opts.jcc?.budgetAmount ?? "0");
  const committed = money(opts.jcc?.committedAmount ?? "0");
  const actual = money(opts.actual);
  const variance = budget.minus(actual);
  const openBudget = budget.minus(committed).minus(actual);
  const percentUsed = budget.isZero()
    ? null
    : actual.dividedBy(budget).times(100).toDecimalPlaces(2).toNumber();
  return {
    jobCostCodeId: opts.jcc?.id ?? null,
    costCodeId: opts.cc.id,
    costCode: opts.cc.code,
    costCodeName: opts.cc.name,
    costType: opts.cc.costType,
    budget: budget.toFixed(4),
    committed: committed.toFixed(4),
    actual: actual.toFixed(4),
    variance: variance.toFixed(4),
    openBudget: openBudget.toFixed(4),
    percentUsed,
    unbudgeted: opts.unbudgeted,
  };
}

function sumDecimal(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(money(v)), money(0));
}
