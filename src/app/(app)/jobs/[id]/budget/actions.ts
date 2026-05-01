"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { costCodes, jobCostCodes, jobs } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import { toDbMoney } from "@/lib/money";

const BudgetSchema = z.object({
  jobId: z.string().uuid(),
  costCodeId: z.string().uuid(),
  budgetAmount: z.string().trim().min(1),
  notes: z.string().optional().or(z.literal("")),
});

const UpdateSchema = z.object({
  jobCostCodeId: z.string().uuid(),
  budgetAmount: z.string().trim().min(1),
  notes: z.string().optional().or(z.literal("")),
});

const RemoveSchema = z.object({
  jobCostCodeId: z.string().uuid(),
});

export type ActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Add a cost code with a budget amount to a job. Idempotent on (jobId,
 * costCodeId) — duplicates rejected at DB level via the unique index, the
 * caller handles 23505 with a friendly error.
 */
export async function addJobCostCode(
  input: z.input<typeof BudgetSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const parsed = BudgetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  // Check the job belongs to this org and isn't closed (you can budget on
  // active/awarded/bid/on_hold but closed is terminal)
  const [job] = await db
    .select({ id: jobs.id, status: jobs.status, code: jobs.code })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, parsed.data.jobId),
        eq(jobs.organizationId, organizationId)
      )
    );
  if (!job) return { ok: false, error: "Job not found." };
  if (job.status === "closed") {
    return { ok: false, error: "Cannot budget a closed job." };
  }

  // Verify cost code belongs to org + is active
  const [cc] = await db
    .select({ id: costCodes.id, code: costCodes.code, isActive: costCodes.isActive })
    .from(costCodes)
    .where(
      and(
        eq(costCodes.id, parsed.data.costCodeId),
        eq(costCodes.organizationId, organizationId)
      )
    );
  if (!cc) return { ok: false, error: "Cost code not found." };
  if (!cc.isActive) {
    return { ok: false, error: `Cost code ${cc.code} is inactive.` };
  }

  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(jobCostCodes)
        .values({
          organizationId,
          jobId: parsed.data.jobId,
          costCodeId: parsed.data.costCodeId,
          budgetAmount: toDbMoney(parsed.data.budgetAmount),
          notes: parsed.data.notes || null,
        })
        .returning({ id: jobCostCodes.id });

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "job.budget.added",
          entityType: "job_cost_code",
          entityId: row.id,
          metadata: {
            jobId: parsed.data.jobId,
            jobCode: job.code,
            costCodeId: parsed.data.costCodeId,
            costCode: cc.code,
            budgetAmount: toDbMoney(parsed.data.budgetAmount),
          },
        },
        tx
      );
      return row.id;
    });

    revalidatePath(`/jobs/${parsed.data.jobId}`);
    revalidatePath(`/jobs/${parsed.data.jobId}/budget`);
    return { ok: true, id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return {
        ok: false,
        error: `Cost code ${cc.code} is already on this job's budget.`,
      };
    }
    console.error("[budget] addJobCostCode failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Update the budget amount or notes on an existing job_cost_codes row.
 * Logged for audit. Cost code itself can't be changed — delete + re-add
 * if you need a different code.
 */
export async function updateJobCostCode(
  input: z.input<typeof UpdateSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const [existing] = await db
    .select()
    .from(jobCostCodes)
    .where(
      and(
        eq(jobCostCodes.id, parsed.data.jobCostCodeId),
        eq(jobCostCodes.organizationId, organizationId)
      )
    );
  if (!existing) return { ok: false, error: "Budget line not found." };

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(jobCostCodes)
        .set({
          budgetAmount: toDbMoney(parsed.data.budgetAmount),
          notes: parsed.data.notes || null,
          updatedAt: sql`now()`,
        })
        .where(eq(jobCostCodes.id, parsed.data.jobCostCodeId));

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "job.budget.updated",
          entityType: "job_cost_code",
          entityId: parsed.data.jobCostCodeId,
          metadata: {
            jobId: existing.jobId,
            costCodeId: existing.costCodeId,
            from: existing.budgetAmount,
            to: toDbMoney(parsed.data.budgetAmount),
          },
        },
        tx
      );
    });

    revalidatePath(`/jobs/${existing.jobId}`);
    revalidatePath(`/jobs/${existing.jobId}/budget`);
    return { ok: true, id: parsed.data.jobCostCodeId };
  } catch (err) {
    console.error("[budget] updateJobCostCode failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Remove a budget line. Allowed even if actuals exist on the (job,
 * cost_code) — the actuals stay in the GL and the line shows up as
 * "unbudgeted" on the report instead. Audit logged so we can see who
 * dropped a budget that had hits against it.
 */
export async function removeJobCostCode(
  input: z.input<typeof RemoveSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const parsed = RemoveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const [existing] = await db
    .select()
    .from(jobCostCodes)
    .where(
      and(
        eq(jobCostCodes.id, parsed.data.jobCostCodeId),
        eq(jobCostCodes.organizationId, organizationId)
      )
    );
  if (!existing) return { ok: false, error: "Budget line not found." };

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(jobCostCodes)
        .where(eq(jobCostCodes.id, parsed.data.jobCostCodeId));

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "job.budget.removed",
          entityType: "job_cost_code",
          entityId: parsed.data.jobCostCodeId,
          metadata: {
            jobId: existing.jobId,
            costCodeId: existing.costCodeId,
            budgetAmount: existing.budgetAmount,
          },
        },
        tx
      );
    });

    revalidatePath(`/jobs/${existing.jobId}`);
    revalidatePath(`/jobs/${existing.jobId}/budget`);
    return { ok: true, id: parsed.data.jobCostCodeId };
  } catch (err) {
    console.error("[budget] removeJobCostCode failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
