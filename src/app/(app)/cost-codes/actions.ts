"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { costCodes } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import { syncCostCodeDimensionValue } from "@/lib/projects/dimension-sync";
import { CSI_DIVISIONS } from "@/lib/seed/csi-masterformat";

const CostCodeSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  description: z.string().optional().or(z.literal("")),
  parentCostCodeId: z.string().uuid().optional().nullable(),
  costType: z.enum([
    "labor",
    "material",
    "equipment",
    "subcontractor",
    "other",
    "overhead",
    "statistical",
  ]),
  isActive: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export type CostCodeInput = z.input<typeof CostCodeSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Shared upsert logic: writes the cost_code row AND keeps the COST_CODE
 * system-dimension value in sync via syncCostCodeDimensionValue.
 */
async function writeWithSync(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  input: z.infer<typeof CostCodeSchema>,
  existingId?: string
): Promise<string> {
  // Resolve parent code if a parent is set (for dimension sync)
  let parentCode: string | null = null;
  if (input.parentCostCodeId) {
    const [parent] = await tx
      .select({ code: costCodes.code })
      .from(costCodes)
      .where(
        and(
          eq(costCodes.id, input.parentCostCodeId),
          eq(costCodes.organizationId, organizationId)
        )
      );
    parentCode = parent?.code ?? null;
  }

  // Mirror into the system dimension first — we need its id to stamp on
  // the cost_code row.
  const dimensionValueId = await syncCostCodeDimensionValue(tx, organizationId, {
    code: input.code,
    name: input.name,
    description: input.description,
    parentCode,
    sortOrder: input.sortOrder,
  });

  if (existingId) {
    await tx
      .update(costCodes)
      .set({
        code: input.code,
        name: input.name,
        description: input.description || null,
        parentCostCodeId: input.parentCostCodeId || null,
        costType: input.costType,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
        dimensionValueId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(costCodes.id, existingId),
          eq(costCodes.organizationId, organizationId)
        )
      );
    return existingId;
  }

  const [row] = await tx
    .insert(costCodes)
    .values({
      organizationId,
      code: input.code,
      name: input.name,
      description: input.description || null,
      parentCostCodeId: input.parentCostCodeId || null,
      costType: input.costType,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
      dimensionValueId,
    })
    .returning({ id: costCodes.id });
  return row.id;
}

export async function createCostCode(
  input: CostCodeInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = CostCodeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const id = await db.transaction(async (tx) => {
      const id = await writeWithSync(tx, organizationId, parsed.data);
      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "cost_code.created",
          entityType: "cost_code",
          entityId: id,
          metadata: { code: parsed.data.code, name: parsed.data.name },
        },
        tx
      );
      return id;
    });
    revalidatePath("/cost-codes");
    return { ok: true, id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already in use.` };
    }
    console.error("[cost-codes] createCostCode failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateCostCode(
  costCodeId: string,
  input: CostCodeInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = CostCodeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  // Guard against making a cost code its own ancestor
  if (parsed.data.parentCostCodeId === costCodeId) {
    return { ok: false, error: "A cost code can't be its own parent." };
  }

  try {
    await db.transaction(async (tx) => {
      await writeWithSync(tx, organizationId, parsed.data, costCodeId);
      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "cost_code.updated",
          entityType: "cost_code",
          entityId: costCodeId,
          metadata: { code: parsed.data.code },
        },
        tx
      );
    });
    revalidatePath("/cost-codes");
    return { ok: true, id: costCodeId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Code conflict." };
    }
    console.error("[cost-codes] updateCostCode failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Seed CSI MasterFormat divisions on demand (e.g., for an org that
 * opted out during onboarding but wants them now). Idempotent — existing
 * codes are skipped.
 */
export async function seedCsiDivisions(): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  try {
    await db.transaction(async (tx) => {
      for (const d of CSI_DIVISIONS) {
        const [existing] = await tx
          .select({ id: costCodes.id })
          .from(costCodes)
          .where(
            and(
              eq(costCodes.organizationId, organizationId),
              eq(costCodes.code, d.code)
            )
          );
        if (existing) continue;
        await writeWithSync(tx, organizationId, {
          code: d.code,
          name: d.name,
          description: d.description ?? "",
          parentCostCodeId: null,
          costType: d.costType ?? "other",
          isActive: true,
          sortOrder: d.sortOrder ?? 0,
        });
      }
      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "cost_code.csi_seeded",
          entityType: "organization",
          entityId: organizationId,
          metadata: { count: CSI_DIVISIONS.length },
        },
        tx
      );
    });
    revalidatePath("/cost-codes");
    return { ok: true, id: organizationId };
  } catch (err) {
    console.error("[cost-codes] seedCsiDivisions failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
