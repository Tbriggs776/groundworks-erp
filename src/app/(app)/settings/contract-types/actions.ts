"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { contractTypes } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";

const ContractTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, numbers, or underscore."),
  name: z.string().trim().min(1).max(100),
  description: z.string().optional().or(z.literal("")),
  isActive: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export type ContractTypeInput = z.input<typeof ContractTypeSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function createContractType(
  input: ContractTypeInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = ContractTypeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const [row] = await db
      .insert(contractTypes)
      .values({
        organizationId,
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description || null,
        isActive: parsed.data.isActive,
        sortOrder: parsed.data.sortOrder,
        isSystem: false,
      })
      .returning({ id: contractTypes.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "contract_type.created",
      entityType: "contract_type",
      entityId: row.id,
      metadata: { code: parsed.data.code, name: parsed.data.name },
    });

    revalidatePath("/settings/contract-types");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already in use.` };
    }
    console.error("[contract-types] createContractType failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateContractType(
  id: string,
  input: ContractTypeInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const [existing] = await db
    .select()
    .from(contractTypes)
    .where(
      and(
        eq(contractTypes.id, id),
        eq(contractTypes.organizationId, organizationId)
      )
    );
  if (!existing) return { ok: false, error: "Contract type not found." };

  // System rows: ignore code changes (they're referenced by convention).
  const newCode = existing.isSystem ? existing.code : input.code;
  const parsed = ContractTypeSchema.safeParse({ ...input, code: newCode });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await db
      .update(contractTypes)
      .set({
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description || null,
        isActive: parsed.data.isActive,
        sortOrder: parsed.data.sortOrder,
        updatedAt: sql`now()`,
      })
      .where(eq(contractTypes.id, id));

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "contract_type.updated",
      entityType: "contract_type",
      entityId: id,
      metadata: { code: parsed.data.code },
    });

    revalidatePath("/settings/contract-types");
    return { ok: true, id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Code conflict." };
    }
    console.error("[contract-types] updateContractType failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteContractType(id: string): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const [existing] = await db
    .select()
    .from(contractTypes)
    .where(
      and(
        eq(contractTypes.id, id),
        eq(contractTypes.organizationId, organizationId)
      )
    );
  if (!existing) return { ok: false, error: "Contract type not found." };
  if (existing.isSystem) {
    return {
      ok: false,
      error:
        "System contract types can't be deleted. Deactivate it instead to hide from pickers.",
    };
  }

  await db
    .delete(contractTypes)
    .where(
      and(
        eq(contractTypes.id, id),
        eq(contractTypes.organizationId, organizationId)
      )
    );

  await writeAudit({
    organizationId,
    actorId: actor?.id ?? null,
    event: "contract_type.deleted",
    entityType: "contract_type",
    entityId: id,
    metadata: { code: existing.code, name: existing.name },
  });

  revalidatePath("/settings/contract-types");
  return { ok: true, id };
}
