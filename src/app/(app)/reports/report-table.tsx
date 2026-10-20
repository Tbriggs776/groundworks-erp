import Link from "next/link";
import { cellText, columnKind, type ReportTable } from "@/lib/reports/table";

/**
 * Any report table on screen, the same rows the CSV and PDF get. Rows with
 * an `href` link to their document; account rows link to their ledger for
 * the report's range when `drill` is given.
 */
export function ReportTableView({
  table,
  companyName,
  drill,
}: {
  table: ReportTable;
  companyName: string;
  drill?: { from?: string; to?: string };
}) {
  return (
    <div className="space-y-3">
      <div className="text-center">
        <div className="font-heading text-2xl tracking-[0.1em]">{companyName.toUpperCase()}</div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mt-1">{table.title}</div>
        <div className="text-xs text-muted-foreground mt-1">{table.subtitle}</div>
      </div>
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 min-w-56">{table.labelColumn}</th>
              {table.columns.map((c, j) => (
                <th key={c} className={`${columnKind(table, j) === "text" ? "text-left" : "text-right"} font-medium px-3 py-2 whitespace-nowrap`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length + 1} className="px-3 py-10 text-center text-xs text-muted-foreground">Nothing to show for this range.</td>
              </tr>
            )}
            {table.rows.map((r, i) => {
              const strong = r.kind === "section" || r.kind === "subtotal" || r.kind === "total";
              const border = r.kind === "total" ? "border-t-2 border-border" : r.kind === "subtotal" ? "border-t border-border" : "";
              const href =
                r.href ??
                (drill && r.accountId
                  ? `/reports/gl-detail?account=${r.accountId}${drill.from ? `&from=${drill.from}` : ""}${drill.to ? `&to=${drill.to}` : ""}`
                  : null);
              return (
                <tr key={i} className={`${border} ${r.kind === "total" ? "bg-muted/30" : ""}`}>
                  <td className={`px-3 py-1.5 ${strong ? "font-semibold" : ""} ${r.kind === "section" ? "text-[11px] uppercase tracking-wider pt-3" : "text-xs"}`} style={{ paddingLeft: `${0.75 + (r.depth ?? 0) * 1.1}rem` }}>
                    {r.code && <span className="font-mono text-muted-foreground mr-2">{r.code}</span>}
                    {href ? (
                      <Link href={href} className="hover:text-primary hover:underline">{r.label}</Link>
                    ) : (
                      r.label
                    )}
                  </td>
                  {table.columns.map((_, j) => (
                    <td key={j} className={`px-3 py-1.5 text-xs ${columnKind(table, j) === "text" ? "text-left" : "text-right font-mono whitespace-nowrap"} ${strong ? "font-semibold" : ""}`}>
                      {cellText(table, j, r.values[j] ?? null)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(table.notes ?? []).map((n) => (
        <p key={n} className="text-xs text-muted-foreground">{n}</p>
      ))}
    </div>
  );
}

/** CSV and PDF downloads: plain links (route handlers; Link would prefetch them). */
export function ExportLinks({ report, params }: { report: string; params: Record<string, string | undefined> }) {
  const qs = (format: string) => {
    const p = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    return `/reports/export/${report}?${p.toString()}`;
  };
  const cls = "inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent";
  return (
    <div className="flex gap-2">
      <a href={qs("csv")} className={cls}>CSV</a>
      <a href={qs("pdf")} target="_blank" rel="noreferrer" className={cls}>PDF</a>
    </div>
  );
}

/** A plain GET form for report filters: works without JavaScript and keeps the URL shareable. */
export function ReportFilters({
  action,
  from,
  to,
  children,
}: {
  action: string;
  from?: string;
  to?: string;
  children?: React.ReactNode;
}) {
  const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";
  const input = "text-sm bg-background border border-border rounded-md px-2 py-1.5";
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      {from !== undefined && (
        <div>
          <div className={label}>From</div>
          <input type="date" name="from" defaultValue={from} className={input} aria-label="From" />
        </div>
      )}
      {to !== undefined && (
        <div>
          <div className={label}>To</div>
          <input type="date" name="to" defaultValue={to} className={input} aria-label="To" />
        </div>
      )}
      {children}
      <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent">
        Run
      </button>
    </form>
  );
}
