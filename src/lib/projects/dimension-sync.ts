import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dimensionValues, dimensions } from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Dimension-value sync. Every Job has a matching row in the JOB system
 * dimension; every Cost Code has a matching row in the COST_CODE system
 * dimension. This lets GL lines tag actuals via the existing
 * gl_line_dimensions infrastructure without a parallel lookup path.
 *
 * Behavior:
 *   - Upserts (insert-or-update) on match of (org, dimension, code).
 *   - Updates the name when it changes in the source entity (job / cost code).
 *   - Never deletes the dimension value — historical GL lines keep
 *     resolving even after the parent job/cost-code is soft-deleted.
 *
 * Returns the dimension_value id so the caller can store it on the source
 * row (jobs.dimension_value_id or cost_codes.dimension_value_id).
 */

async function upsertDimensionValue(
  tx: Tx,
  organizationId: string,
  dimensionCode: string,
  entity: {
    code: string;
    name: string;
    description?: string | null;
    parentCode?: string | null;
    sortOrder?: number;
  }
): Promise<string> {
  const [dim] = await tx
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(
      and(
        eq(dimensions.organizationId, organizationId),
        eq(dimensions.code, dimensionCode)
      )
    );
  if (!dim) {
    throw new Error(
      `System dimension "${dimensionCode}" not found for this organization. Re-run org seeding.`
    );
  }

  // Find parent dimension value if the entity references one
  let parentValueId: string | null = null;
  if (entity.parentCode) {
    const [parent] = await tx
      .select({ id: dimensionValues.id })
      .from(dimensionValues)
      .where(
        and(
          eq(dimensionValues.organizationId, organizationId),
          eq(dimensionValues.dimensionId, dim.id),
          eq(dimensionValues.code, entity.parentCode)
        )
      );
    parentValueId = parent?.id ?? null;
  }

  // Try to find existing value
  const [existing] = await tx
    .select({ id: dimensionValues.id })
    .from(dimensionValues)
    .where(
      and(
        eq(dimensionValues.organizationId, organizationId),
        eq(dimensionValues.dimensionId, dim.id),
        eq(dimensionValues.code, entity.code)
      )
    );

  if (existing) {
    await tx
      .update(dimensionValues)
      .set({
        name: entity.name,
        description: entity.description ?? null,
        parentValueId,
        sortOrder: entity.sortOrder ?? 0,
        updatedAt: sql`now()`,
      })
      .where(eq(dimensionValues.id, existing.id));
    return existing.id;
  }

  const [row] = await tx
    .insert(dimensionValues)
    .values({
      organizationId,
      dimensionId: dim.id,
      code: entity.code,
      name: entity.name,
      description: entity.description ?? null,
      parentValueId,
      sortOrder: entity.sortOrder ?? 0,
    })
    .returning({ id: dimensionValues.id });
  return row.id;
}

export async function syncJobDimensionValue(
  tx: Tx,
  organizationId: string,
  job: { code: string; name: string; description?: string | null }
): Promise<string> {
  return upsertDimensionValue(tx, organizationId, "JOB", job);
}

export async function syncCostCodeDimensionValue(
  tx: Tx,
  organizationId: string,
  costCode: {
    code: string;
    name: string;
    description?: string | null;
    parentCode?: string | null;
    sortOrder?: number;
  }
): Promise<string> {
  return upsertDimensionValue(tx, organizationId, "COST_CODE", costCode);
}
