"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  allocationGroups,
  allocationTargets,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import { runAllocation as runAllocationRunner } from "@/lib/gl/allocations";

const TargetSchema = z.object({
  accountId: z.string().uuid(),
  percent: z.string().trim(),
  memo: z.string().trim().max(200).optional().or(z.literal("")),
});

const GroupSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  allocationType: z.enum(["fixed", "statistical"]).default("fixed"),
  sourceStatisticalAccountId: z.string().uuid().optional().nullable(),
  isActive: z.coerce.boolean().default(true),
  targets: z.array(TargetSchema).min(2, "Allocation needs at least 2 targets."),
});

export type AllocationInput = z.infer<typeof GroupSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

function validatePercents(
  targets: AllocationInput["targets"]
): { ok: true } | { ok: false; error: string } {
  let sum = 0;
  for (const t of targets) {
    const n = Number(t.percent);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: "Each percent must be a non-negative number." };
    }
    sum += n;
  }
  // Allow 0.0001 tolerance to forgive floating-point rounding in the UI
  if (Math.abs(sum - 100) > 0.0001) {
    return { ok: false, error: `Percents must sum to 100 (got ${sum}).` };
  }
  return { ok: true };
}

export async function createAllocation(
  input: AllocationInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = GroupSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const pct = validatePercents(parsed.data.targets);
  if (!pct.ok) return pct;

  try {
    const id = await db.transaction(async (tx) => {
      const [grp] = await tx
        .insert(allocationGroups)
        .values({
          organizationId,
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description || null,
          allocationType: parsed.data.allocationType,
          sourceStatisticalAccountId:
            parsed.data.sourceStatisticalAccountId || null,
          isActive: parsed.data.isActive,
        })
        .returning({ id: allocationGroups.id });

      await tx.insert(allocationTargets).values(
        parsed.data.targets.map((t) => ({
          organizationId,
          allocationGroupId: grp.id,
          accountId: t.accountId,
          percent: t.percent,
          memo: t.memo || null,
        }))
      );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "allocation.created",
          entityType: "allocation_group",
          entityId: grp.id,
          metadata: { code: parsed.data.code, targets: parsed.data.targets.length },
        },
        tx
      );

      return grp.id;
    });

    revalidatePath("/allocations");
    return { ok: true, id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already in use.` };
    }
    console.error("[allocations] createAllocation failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateAllocation(
  groupId: string,
  input: AllocationInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = GroupSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const pct = validatePercents(parsed.data.targets);
  if (!pct.ok) return pct;

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(allocationGroups)
        .set({
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description || null,
          allocationType: parsed.data.allocationType,
          sourceStatisticalAccountId:
            parsed.data.sourceStatisticalAccountId || null,
          isActive: parsed.data.isActive,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(allocationGroups.id, groupId),
            eq(allocationGroups.organizationId, organizationId)
          )
        );

      await tx
        .delete(allocationTargets)
        .where(eq(allocationTargets.allocationGroupId, groupId));

      await tx.insert(allocationTargets).values(
        parsed.data.targets.map((t) => ({
          organizationId,
          allocationGroupId: groupId,
          accountId: t.accountId,
          percent: t.percent,
          memo: t.memo || null,
        }))
      );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "allocation.updated",
          entityType: "allocation_group",
          entityId: groupId,
          metadata: { code: parsed.data.code },
        },
        tx
      );
    });

    revalidatePath("/allocations");
    revalidatePath(`/allocations/${groupId}`);
    return { ok: true, id: groupId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already in use.` };
    }
    console.error("[allocations] updateAllocation failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Execute the allocation with a concrete amount + source account. Posts a
 * balanced JE atomically and returns its id.
 */
export async function runAllocation(input: {
  groupId: string;
  totalAmount: string;
  sourceAccountId: string;
  journalDate: string;
  description: string;
}): Promise<
  | { ok: true; journalId: string; journalNumber: string }
  | { ok: false; error: string }
> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const r = await runAllocationRunner({
    organizationId,
    actorId: actor?.id ?? null,
    groupId: input.groupId,
    totalAmount: input.totalAmount,
    sourceAccountId: input.sourceAccountId,
    journalDate: input.journalDate,
    description: input.description,
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/gl");
  revalidatePath("/allocations");
  return { ok: true, journalId: r.journalId, journalNumber: r.journalNumber };
}
