import { addMonths, endOfMonth, format, startOfMonth } from "date-fns";
import { db } from "@/lib/db/client";
import { fiscalPeriods, fiscalYears } from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Generate a fiscal year with 12 monthly periods for an organization.
 * Idempotent via the unique (organization_id, year_label) constraint on
 * fiscal_years — callers should check existence first if they care about
 * signalling duplicates.
 *
 *   startDate  — first day of the fiscal year (e.g. '2026-01-01')
 *   yearLabel  — human-readable label ('FY2026')
 *
 * Returns the fiscal year id + array of period ids.
 */
export async function generateFiscalYear(
  tx: Tx,
  opts: {
    organizationId: string;
    startDate: string; // YYYY-MM-DD, must be first-of-month
    yearLabel: string;
  }
): Promise<{ fiscalYearId: string; periodIds: string[] }> {
  const start = startOfMonth(new Date(opts.startDate));
  const end = endOfMonth(addMonths(start, 11));

  const [year] = await tx
    .insert(fiscalYears)
    .values({
      organizationId: opts.organizationId,
      yearLabel: opts.yearLabel,
      startDate: format(start, "yyyy-MM-dd"),
      endDate: format(end, "yyyy-MM-dd"),
      status: "open",
    })
    .returning({ id: fiscalYears.id });

  const periodRows = [];
  for (let i = 0; i < 12; i++) {
    const periodStart = addMonths(start, i);
    const periodEnd = endOfMonth(periodStart);
    periodRows.push({
      organizationId: opts.organizationId,
      fiscalYearId: year.id,
      periodNo: i + 1,
      periodCode: `${opts.yearLabel}-${String(i + 1).padStart(2, "0")}`,
      startDate: format(periodStart, "yyyy-MM-dd"),
      endDate: format(periodEnd, "yyyy-MM-dd"),
      status: "open" as const,
    });
  }

  const inserted = await tx
    .insert(fiscalPeriods)
    .values(periodRows)
    .returning({ id: fiscalPeriods.id });

  return { fiscalYearId: year.id, periodIds: inserted.map((r) => r.id) };
}
