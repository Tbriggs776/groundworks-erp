"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { approvalThresholds } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";

const ThresholdSchema = z.object({
  scope: z.enum(["ap_bill"]).default("ap_bill"),
  tierName: z.string().trim().min(1).max(100),
  minAmount: z.string().trim(),
  maxAmount: z.string().optional().or(z.literal("")),
  requiredRole: z.enum([
    "owner",
    "admin",
    "accountant",
    "pm",
    "foreman",
    "viewer",
  ]),
  isActive: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export type ThresholdInput = z.input<typeof ThresholdSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function createThreshold(
  input: ThresholdInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = ThresholdSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const min = Number(parsed.data.minAmount);
  const max = parsed.data.maxAmount ? Number(parsed.data.maxAmount) : null;
  if (!Number.isFinite(min) || min < 0) {
    return { ok: false, error: "min_amount must be a non-negative number." };
  }
  if (max !== null && (!Number.isFinite(max) || max <= min)) {
    return { ok: false, error: "max_amount must be > min_amount (or blank for unbounded)." };
  }

  try {
    const [row] = await db
      .insert(approvalThresholds)
      .values({
        organizationId,
        scope: parsed.data.scope,
        tierName: parsed.data.tierName,
        minAmount: parsed.data.minAmount,
        maxAmount: parsed.data.maxAmount || null,
        requiredRole: parsed.data.requiredRole,
        isActive: parsed.data.isActive,
        sortOrder: parsed.data.sortOrder,
      })
      .returning({ id: approvalThresholds.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "approval_threshold.created",
      entityType: "approval_threshold",
      entityId: row.id,
      metadata: parsed.data,
    });

    revalidatePath("/settings/approval-thresholds");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return {
        ok: false,
        error: `A tier named "${parsed.data.tierName}" already exists in this scope.`,
      };
    }
    console.error("[approval-thresholds] create failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateThreshold(
  id: string,
  input: ThresholdInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = ThresholdSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await db
      .update(approvalThresholds)
      .set({
        tierName: parsed.data.tierName,
        minAmount: parsed.data.minAmount,
        maxAmount: parsed.data.maxAmount || null,
        requiredRole: parsed.data.requiredRole,
        isActive: parsed.data.isActive,
        sortOrder: parsed.data.sortOrder,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(approvalThresholds.id, id),
          eq(approvalThresholds.organizationId, organizationId)
        )
      );

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "approval_threshold.updated",
      entityType: "approval_threshold",
      entityId: id,
      metadata: parsed.data,
    });

    revalidatePath("/settings/approval-thresholds");
    return { ok: true, id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Tier name conflict." };
    }
    console.error("[approval-thresholds] update failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteThreshold(id: string): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const [existing] = await db
    .select()
    .from(approvalThresholds)
    .where(
      and(
        eq(approvalThresholds.id, id),
        eq(approvalThresholds.organizationId, organizationId)
      )
    );
  if (!existing) return { ok: false, error: "Threshold not found." };

  await db
    .delete(approvalThresholds)
    .where(eq(approvalThresholds.id, id));

  await writeAudit({
    organizationId,
    actorId: actor?.id ?? null,
    event: "approval_threshold.deleted",
    entityType: "approval_threshold",
    entityId: id,
    metadata: { tierName: existing.tierName },
  });

  revalidatePath("/settings/approval-thresholds");
  return { ok: true, id };
}
