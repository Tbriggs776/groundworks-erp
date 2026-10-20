import Link from "next/link";
import type { AgingBuckets, AgingReport } from "@/lib/reports/aging";
import { formatMoney, money } from "@/lib/money";

const COLUMNS: Array<[keyof AgingBuckets, string]> = [
  ["current", "Current"],
  ["days1to30", "1–30"],
  ["days31to60", "31–60"],
  ["days61to90", "61–90"],
  ["over90", "Over 90"],
  ["total", "Total"],
];

function Cell({ v, strong }: { v: string; strong?: boolean }) {
  return (
    <td className={`px-3 py-2 text-right font-mono text-xs ${strong ? "font-semibold" : ""}`}>
      {money(v).isZero() ? <span className="text-muted-foreground">—</span> : formatMoney(v)}
    </td>
  );
}

/** Party × bucket grid shared by the AR and AP aging reports. */
export function AgingTable({
  report,
  partyLabel,
  docHref,
}: {
  report: AgingReport;
  partyLabel: string;
  docHref: (id: string, kind: string) => string;
}) {
  return (
    <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium px-3 py-2">{partyLabel}</th>
            {COLUMNS.map(([k, label]) => (
              <th key={k} className="text-right font-medium px-3 py-2 w-28">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.parties.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">
                Nothing outstanding as of {report.asOf}.
              </td>
            </tr>
          )}
          {report.parties.map((p) => (
            <tr key={p.partyId} className="border-t border-border align-top">
              <td className="px-3 py-2">
                <div>{p.partyName}</div>
                <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground font-mono">
                  {p.documents.map((d) => (
                    <Link key={d.id} href={docHref(d.id, d.kind)} className="hover:text-primary">
                      {d.number}
                      {d.daysPastDue > 0 ? ` (${d.daysPastDue}d)` : ""}
                    </Link>
                  ))}
                </div>
              </td>
              {COLUMNS.map(([k]) => (
                <Cell key={k} v={p.buckets[k]} strong={k === "total"} />
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/30">
            <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
            {COLUMNS.map(([k]) => (
              <Cell key={k} v={report.totals[k]} strong />
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
