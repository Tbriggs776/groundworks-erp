import {
  addMonths,
  endOfMonth,
  format,
  isBefore,
  isEqual,
  startOfMonth,
} from "date-fns";

/**
 * Date and fiscal-period helpers for Groundworks.
 *
 * Construction accounting runs on monthly periods. An organization's fiscal
 * year starts on a configurable month (1–12). All period math lives here so
 * the GL, billing, and reporting modules agree on what "Period 3" means.
 */

/** Calendar-month period code, e.g. "2026-04". */
export type PeriodCode = string;

export function toPeriodCode(date: Date): PeriodCode {
  return format(date, "yyyy-MM");
}

export function fromPeriodCode(code: PeriodCode): Date {
  const [y, m] = code.split("-").map(Number);
  return new Date(y, m - 1, 1);
}

export function periodStart(code: PeriodCode): Date {
  return startOfMonth(fromPeriodCode(code));
}

export function periodEnd(code: PeriodCode): Date {
  return endOfMonth(fromPeriodCode(code));
}

/**
 * Returns the fiscal-year label for a given period.
 *   e.g. FY start = July (7), period = 2026-03 → FY2026
 *        FY start = July (7), period = 2026-08 → FY2027
 */
export function fiscalYearFor(
  code: PeriodCode,
  fiscalYearStartMonth: number
): number {
  const date = fromPeriodCode(code);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  return month >= fiscalYearStartMonth ? year + 1 : year;
}

/**
 * Enumerate all periods from `from` to `to` (inclusive), both as YYYY-MM codes.
 */
export function periodRange(from: PeriodCode, to: PeriodCode): PeriodCode[] {
  const out: PeriodCode[] = [];
  let cursor = startOfMonth(fromPeriodCode(from));
  const end = startOfMonth(fromPeriodCode(to));
  while (isBefore(cursor, end) || isEqual(cursor, end)) {
    out.push(toPeriodCode(cursor));
    cursor = addMonths(cursor, 1);
  }
  return out;
}
