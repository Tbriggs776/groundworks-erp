"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  dimensions,
  dimensionValues,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";

/**
 * Dimensions CRUD. System dimensions (isSystem=true) can have their display
 * `name` and `description` edited but not the `code` — subledger modules
 * rely on the code being stable. Deletion of system dimensions is also
 * blocked (we don't expose a delete action yet regardless).
 */

const codeRegex = /^[A-Z0-9_]+$/;

const DimensionSchema = z.object({
  code: z.string().trim().min(1).max(32).regex(codeRegex, "Code must be uppercase letters, numbers, or underscore."),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  sortOrder: z.coerce.number().int().default(0),
  isBlocked: z.coerce.boolean().default(false),
});

const DimensionValueSchema = z.object({
  dimensionId: z.string().uuid(),
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  parentValueId: z.string().uuid().optional().nullable(),
  isBlocked: z.coerce.boolean().default(false),
  isTotal: z.coerce.boolean().default(false),
  sortOrder: z.coerce.number().int().default(0),
});

export type ActionResult<T = { id: string }> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Dimension CRUD
// ---------------------------------------------------------------------------

export async function createDimension(
  input: z.infer<typeof DimensionSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const parsed = DimensionSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const [row] = await db
      .insert(dimensions)
      .values({
        organizationId,
        ...parsed.data,
        description: parsed.data.description || null,
        isSystem: false,
      })
      .returning({ id: dimensions.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "dimension.created",
      entityType: "dimension",
      entityId: row.id,
      metadata: { code: parsed.data.code, name: parsed.data.name },
    });

    revalidatePath("/dimensions");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already exists.` };
    }
    console.error("[dimensions] createDimension failed:", err);
    return { ok: false, error: "Could not create dimension." };
  }
}

export async function updateDimension(
  dimensionId: string,
  input: Omit<z.infer<typeof DimensionSchema>, "code"> & { code?: string }
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  const [existing] = await db
    .select()
    .from(dimensions)
    .where(
      and(
        eq(dimensions.id, dimensionId),
        eq(dimensions.organizationId, organizationId)
      )
    );
  if (!existing) return { ok: false, error: "Dimension not found." };

  // System dimensions: ignore code change attempts.
  const newCode = existing.isSystem ? existing.code : input.code ?? existing.code;
  const parsed = DimensionSchema.safeParse({ ...input, code: newCode });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await db
      .update(dimensions)
      .set({
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        isBlocked: parsed.data.isBlocked,
      })
      .where(eq(dimensions.id, dimensionId));

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "dimension.updated",
      entityType: "dimension",
      entityId: dimensionId,
      metadata: { changes: parsed.data },
    });

    revalidatePath("/dimensions");
    return { ok: true, id: dimensionId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Code conflict." };
    }
    console.error("[dimensions] updateDimension failed:", err);
    return { ok: false, error: "Could not update dimension." };
  }
}

// ---------------------------------------------------------------------------
// Dimension value CRUD
// ---------------------------------------------------------------------------

export async function createDimensionValue(
  input: z.infer<typeof DimensionValueSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = DimensionValueSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  // Guard: the dimension must belong to this org
  const [dim] = await db
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(
      and(
        eq(dimensions.id, parsed.data.dimensionId),
        eq(dimensions.organizationId, organizationId)
      )
    );
  if (!dim) return { ok: false, error: "Dimension not found." };

  try {
    const [row] = await db
      .insert(dimensionValues)
      .values({
        organizationId,
        dimensionId: parsed.data.dimensionId,
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description || null,
        parentValueId: parsed.data.parentValueId || null,
        isBlocked: parsed.data.isBlocked,
        isTotal: parsed.data.isTotal,
        sortOrder: parsed.data.sortOrder,
      })
      .returning({ id: dimensionValues.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "dimension_value.created",
      entityType: "dimension_value",
      entityId: row.id,
      metadata: {
        dimensionId: parsed.data.dimensionId,
        code: parsed.data.code,
        name: parsed.data.name,
      },
    });

    revalidatePath("/dimensions");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already exists in this dimension.` };
    }
    console.error("[dimensions] createDimensionValue failed:", err);
    return { ok: false, error: "Could not create value." };
  }
}

export async function updateDimensionValue(
  valueId: string,
  input: Omit<z.infer<typeof DimensionValueSchema>, "dimensionId"> & {
    dimensionId?: string;
  }
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const [existing] = await db
    .select()
    .from(dimensionValues)
    .where(
      and(
        eq(dimensionValues.id, valueId),
        eq(dimensionValues.organizationId, organizationId)
      )
    );
  if (!existing) return { ok: false, error: "Value not found." };

  const parsed = DimensionValueSchema.safeParse({
    ...input,
    dimensionId: existing.dimensionId,
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  // Don't allow a value to become its own ancestor (simple cycle check)
  if (parsed.data.parentValueId === valueId) {
    return { ok: false, error: "A value can't be its own parent." };
  }

  try {
    await db
      .update(dimensionValues)
      .set({
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description || null,
        parentValueId: parsed.data.parentValueId || null,
        isBlocked: parsed.data.isBlocked,
        isTotal: parsed.data.isTotal,
        sortOrder: parsed.data.sortOrder,
      })
      .where(eq(dimensionValues.id, valueId));

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "dimension_value.updated",
      entityType: "dimension_value",
      entityId: valueId,
      metadata: { changes: parsed.data },
    });

    revalidatePath("/dimensions");
    return { ok: true, id: valueId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: "Code conflict within this dimension." };
    }
    console.error("[dimensions] updateDimensionValue failed:", err);
    return { ok: false, error: "Could not update value." };
  }
}
