import Link from "next/link";
import { formatMoney, money } from "@/lib/money";

/**
 * The body of a sales document's page: lines, then subtotal, sales tax by
 * component, total, and any balance rows. Server-safe, no state.
 */
export function DocLines({
  lines,
  subtotal,
  taxLines,
  taxExempt,
  total,
  currency,
  extraRows = [],
  taxTotal,
}: {
  lines: Array<{ id: string; lineNumber: number; itemName: string | null; description: string | null; quantity: string; unitPrice: string; amount: string; taxable: boolean }>;
  subtotal: string;
  taxLines: Array<{ id: string; agencyName: string; ratePercent: string; taxAmount: string }>;
  taxExempt: boolean;
  total: string;
  currency: string;
  extraRows?: Array<{ label: string; value: string; strong?: boolean }>;
  /** Documents that don't keep tax lines (estimates, templates): one row instead. */
  taxTotal?: { label: string; amount: string };
}) {
  const fmt = (v: string) => formatMoney(v, { currency });
  return (
    <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium px-3 py-2 w-10">#</th>
            <th className="text-left font-medium px-3 py-2">Product / service</th>
            <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
            <th className="text-right font-medium px-3 py-2 w-28">Rate</th>
            <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
            <th className="text-center font-medium px-3 py-2 w-12">Tax</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-border">
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.lineNumber}</td>
              <td className="px-3 py-2">
                {l.itemName && <div className="text-sm">{l.itemName}</div>}
                {l.description && l.description !== l.itemName && <div className="text-xs text-muted-foreground">{l.description}</div>}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{money(l.quantity).toString()}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.unitPrice)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
              <td className="px-3 py-2 text-center text-xs text-muted-foreground">{l.taxable ? "T" : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-muted/30">
          <FootRow label="Subtotal" value={fmt(subtotal)} first />
          {taxLines.map((t) => (
            <FootRow key={t.id} label={`${t.agencyName} ${money(t.ratePercent).toString()}%${taxExempt ? " (exempt)" : ""}`} value={fmt(t.taxAmount)} />
          ))}
          {taxTotal && <FootRow label={`${taxTotal.label}${taxExempt ? " (exempt)" : ""}`} value={fmt(taxTotal.amount)} />}
          <FootRow label="Total" value={fmt(total)} strong />
          {extraRows.map((r) => (
            <FootRow key={r.label} label={r.label} value={r.value} strong={r.strong} />
          ))}
        </tfoot>
      </table>
    </div>
  );
}

function FootRow({ label, value, strong, first }: { label: string; value: string; strong?: boolean; first?: boolean }) {
  return (
    <tr className={first ? "border-t-2 border-border" : undefined}>
      <td colSpan={4} className="px-3 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">{label}</td>
      <td className={`px-3 py-1 text-right font-mono ${strong ? "text-sm font-semibold" : "text-xs"}`}>{value}</td>
      <td></td>
    </tr>
  );
}

/** "Posted to the ledger · view journal" and the voided banner. */
export function LedgerNotes({
  status,
  glJournalId,
  voidGlJournalId,
  voidReason,
  agentDraft,
}: {
  status: string;
  glJournalId: string | null;
  voidGlJournalId: string | null;
  voidReason: string | null;
  agentDraft: boolean;
}) {
  return (
    <>
      {status === "draft" && agentDraft && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
          Drafted by an agent and waiting for review. Check it, then post it or delete it.
        </div>
      )}
      {status === "voided" && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="uppercase tracking-wider font-semibold">Voided</span>
          {voidReason && <>: {voidReason}</>}
          {voidGlJournalId && (
            <>
              {" · "}
              <Link href={`/gl/${voidGlJournalId}`} className="text-primary hover:underline">reversal journal</Link>
            </>
          )}
        </div>
      )}
      {glJournalId && status !== "voided" && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          Posted to the ledger ·{" "}
          <Link href={`/gl/${glJournalId}`} className="text-primary hover:underline">view journal</Link>
        </div>
      )}
    </>
  );
}

export function Notes({ memo, privateNote }: { memo: string | null; privateNote: string | null }) {
  if (!memo && !privateNote) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
      {memo && (
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Message</div>
          {memo}
        </div>
      )}
      {privateNote && (
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Private note</div>
          {privateNote}
        </div>
      )}
    </div>
  );
}
