import type Decimal from "decimal.js";
import { formatMoney, money } from "@/lib/money";
import { toCsv } from "@/lib/ui/csv";

/**
 * One shape for every report a person or agent can read or export: a title,
 * the value columns, and rows. The same table renders on screen, as CSV,
 * and as a PDF, so all three always agree.
 *
 * Row kinds:
 *   section   a heading ("Operating Revenue"); no values
 *   account   one account (or party, or line), indented under its section
 *   subtotal  a section's total ("Total COGS")
 *   total     a key result ("Gross Profit", "Net Income")
 *   note      a line of text spanning the table
 */

export type ReportRowKind = "section" | "account" | "subtotal" | "total" | "note";

export type ReportRow = {
  kind: ReportRowKind;
  label: string;
  /** One per column; null where a cell is empty. Money as fixed 2-place strings. */
  values: Array<string | null>;
  code?: string;
  /** Lets a screen link the row to its ledger. */
  accountId?: string;
  /** Lets a screen link the row to its document. Screen only. */
  href?: string;
  depth?: number;
};

export type ColumnKind = "money" | "number" | "text";

export type ReportTable = {
  title: string;
  subtitle: string;
  /** Heading of the label column ("Account", "Vendor", "Date"). */
  labelColumn: string;
  columns: string[];
  /**
   * Per column: money (the default: 2-place strings print as money), number
   * (as given, right-aligned: quantities, days), or text (as given, left-aligned).
   */
  columnKinds?: ColumnKind[];
  rows: ReportRow[];
  notes?: string[];
};

export const fmt2 = (d: Decimal) => d.toFixed(2);

export const columnKind = (t: ReportTable, column: number): ColumnKind => t.columnKinds?.[column] ?? "money";

/** A cell for screen and PDF: money strings as money, anything else as is. */
export function cellText(t: ReportTable, column: number, v: string | null): string {
  if (v === null) return "";
  return columnKind(t, column) === "money" && /^-?\d+\.\d{2}$/.test(v) ? formatMoney(money(v)) : v;
}

/** CSV of a report: label column (with account codes), then each value column. */
export function reportCsv(t: ReportTable): string {
  const rows = t.rows.map((r) => [
    `${"  ".repeat(r.depth ?? 0)}${r.code ? `${r.code} ` : ""}${r.label}`,
    ...t.columns.map((_, i) => r.values[i] ?? ""),
  ]);
  return toCsv([t.labelColumn, ...t.columns], [[t.title, ...t.columns.map(() => "")], [t.subtitle, ...t.columns.map(() => "")], ...rows]);
}

/** File-name friendly report title. */
export function reportFileName(t: ReportTable, ext: string): string {
  return `${`${t.title} ${t.subtitle}`.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "")}.${ext}`;
}
