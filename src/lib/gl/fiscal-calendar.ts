import { addMonths, endOfMonth, format, startOfMonth } from "date-fns";
import { sql } from "drizzle-orm";
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

/**
 * Make sure a fiscal year covers `date` (YYYY-MM-DD), generating it (and
 * any years between it and the company's existing ones) when missing.
 * Years start on the company's fiscal year start month and are labeled by
 * the calendar year they end in.
 */
export async function ensureFiscalYearFor(tx: Tx, organizationId: string, startMonth: number, date: string): Promise<void> {
  const covered = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM fiscal_years WHERE organization_id = ${organizationId} AND ${date}::date BETWEEN start_date AND end_date`
  );
  if ((covered[0]?.n ?? 0) > 0) return;
  const d = new Date(`${date}T00:00:00`);
  const startYear = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
  const start = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const label = `FY${startYear + (startMonth === 1 ? 0 : 1)}`;
  const existing = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM fiscal_years WHERE organization_id = ${organizationId} AND year_label = ${label}`
  );
  if ((existing[0]?.n ?? 0) > 0) return;
  await generateFiscalYear(tx, { organizationId, startDate: start, yearLabel: label });
}
