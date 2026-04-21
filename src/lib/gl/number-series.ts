import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { numberSeries } from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomically allocate the next number from a series.
 *
 *   UPDATE number_series SET last_used_number = last_used_number + increment
 *   WHERE organization_id = $1 AND code = $2 RETURNING ...
 *
 * Postgres serializes concurrent updates on the same row via its row-level
 * locks, so two simultaneous callers never get the same number.
 *
 * Format: `${prefix}${pad(last_used_number, width)}`.
 */
export async function nextNumber(
  tx: Tx,
  organizationId: string,
  seriesCode: string
): Promise<string> {
  const [row] = await tx
    .update(numberSeries)
    .set({
      lastUsedNumber: sql`${numberSeries.lastUsedNumber} + ${numberSeries.increment}`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(numberSeries.organizationId, organizationId),
        eq(numberSeries.code, seriesCode),
        eq(numberSeries.isActive, true)
      )
    )
    .returning({
      prefix: numberSeries.prefix,
      lastUsedNumber: numberSeries.lastUsedNumber,
      width: numberSeries.width,
    });

  if (!row) {
    throw new Error(
      `Number series "${seriesCode}" not found (or inactive) for this organization.`
    );
  }

  const padded = String(row.lastUsedNumber).padStart(row.width, "0");
  return `${row.prefix}${padded}`;
}
