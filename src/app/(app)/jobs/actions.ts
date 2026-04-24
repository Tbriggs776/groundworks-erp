"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { jobs, type Address } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import { syncJobDimensionValue } from "@/lib/projects/dimension-sync";

const JobSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  description: z.string().optional().or(z.literal("")),
  customerId: z.string().uuid(),
  projectManagerId: z.string().uuid().optional().nullable(),
  contractTypeId: z.string().uuid().optional().nullable(),
  contractAmount: z.string().optional().or(z.literal("")),
  contractDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  estimatedEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  actualEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  retainagePercent: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  isActive: z.coerce.boolean().default(true),
});

export type JobInput = z.input<typeof JobSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * State machine for job.status. Transitions are strict; callers that need
 * to skip a state must go through the allowed intermediate transitions or
 * obtain admin override (future feature).
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  bid: ["awarded", "closed"],
  awarded: ["active", "closed"],
  active: ["on_hold", "closed"],
  on_hold: ["active", "closed"],
  closed: [], // terminal — reopen requires admin override (TODO)
};

export async function createJob(input: JobInput): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = JobSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const id = await db.transaction(async (tx) => {
      const dimensionValueId = await syncJobDimensionValue(tx, organizationId, {
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description,
      });

      const [row] = await tx
        .insert(jobs)
        .values({
          organizationId,
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description || null,
          customerId: parsed.data.customerId,
          projectManagerId: parsed.data.projectManagerId || null,
          contractTypeId: parsed.data.contractTypeId || null,
          contractAmount: parsed.data.contractAmount || "0",
          contractDate: parsed.data.contractDate || null,
          startDate: parsed.data.startDate || null,
          estimatedEndDate: parsed.data.estimatedEndDate || null,
          actualEndDate: parsed.data.actualEndDate || null,
          retainagePercent: parsed.data.retainagePercent || "0",
          isActive: parsed.data.isActive,
          notes: parsed.data.notes || null,
          dimensionValueId,
          status: "bid",
          addresses: [] as Address[],
        })
        .returning({ id: jobs.id });

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "job.created",
          entityType: "job",
          entityId: row.id,
          metadata: {
            code: parsed.data.code,
            name: parsed.data.name,
            customerId: parsed.data.customerId,
          },
        },
        tx
      );
      return row.id;
    });

    revalidatePath("/jobs");
    return { ok: true, id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Job code "${parsed.data.code}" already in use.` };
    }
    console.error("[jobs] createJob failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateJob(
  jobId: string,
  input: JobInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = JobSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await db.transaction(async (tx) => {
      // Sync dimension value (updates the display name if it changed)
      const dimensionValueId = await syncJobDimensionValue(tx, organizationId, {
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description,
      });

      await tx
        .update(jobs)
        .set({
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description || null,
          customerId: parsed.data.customerId,
          projectManagerId: parsed.data.projectManagerId || null,
          contractTypeId: parsed.data.contractTypeId || null,
          contractAmount: parsed.data.contractAmount || "0",
          contractDate: parsed.data.contractDate || null,
          startDate: parsed.data.startDate || null,
          estimatedEndDate: parsed.data.estimatedEndDate || null,
          actualEndDate: parsed.data.actualEndDate || null,
          retainagePercent: parsed.data.retainagePercent || "0",
          isActive: parsed.data.isActive,
          notes: parsed.data.notes || null,
          dimensionValueId,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId))
        );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "job.updated",
          entityType: "job",
          entityId: jobId,
          metadata: { code: parsed.data.code },
        },
        tx
      );
    });

    revalidatePath("/jobs");
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, id: jobId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Code conflict." };
    }
    console.error("[jobs] updateJob failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Transition a job's status. Enforces the state machine — illegal
 * transitions are rejected. Every transition is audit-logged with before/
 * after status so the full lifecycle is auditable.
 */
export async function transitionJobStatus(input: {
  jobId: string;
  toStatus: "bid" | "awarded" | "active" | "on_hold" | "closed";
  actualEndDate?: string; // required when closing
  note?: string;
}): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const [job] = await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.id, input.jobId), eq(jobs.organizationId, organizationId))
    );
  if (!job) return { ok: false, error: "Job not found." };

  const allowed = ALLOWED_TRANSITIONS[job.status] ?? [];
  if (!allowed.includes(input.toStatus)) {
    return {
      ok: false,
      error: `Cannot transition from ${job.status} to ${input.toStatus}. Allowed: ${
        allowed.join(", ") || "(none — terminal)"
      }.`,
    };
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({
          status: input.toStatus,
          statusChangedAt: sql`now()`,
          statusChangedBy: actor?.id ?? null,
          actualEndDate:
            input.toStatus === "closed" && input.actualEndDate
              ? input.actualEndDate
              : job.actualEndDate,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, input.jobId));

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: `job.status.${input.toStatus}`,
          entityType: "job",
          entityId: input.jobId,
          metadata: {
            from: job.status,
            to: input.toStatus,
            note: input.note,
            actualEndDate: input.actualEndDate,
          },
        },
        tx
      );
    });

    revalidatePath("/jobs");
    revalidatePath(`/jobs/${input.jobId}`);
    return { ok: true, id: input.jobId };
  } catch (err) {
    console.error("[jobs] transitionJobStatus failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
