"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { deleteEstimate, invoiceEstimate, setEstimateStatus } from "../actions";

type BillLine = { id: string; lineNumber: number; label: string; amount: string; remaining: string };
type Mode = "remaining" | "percent" | "custom";

/** Same math as the server: percent of the estimate line, rounded, never past what's left. */
function percentOf(l: BillLine, pct: string): Decimal {
  let amt: Decimal;
  try {
    amt = money(l.amount).times(money(pct || "0")).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } catch {
    return money(0);
  }
  const left = money(l.remaining);
  return (money(l.amount).isNegative() ? amt.lt(left) : amt.gt(left)) ? left : amt;
}

export function EstimateActions({
  estimate,
  lines,
}: {
  estimate: {
    id: string;
    estimateNumber: string;
    status: string;
    currency: string;
    invoiceCount: number;
    acceptedDate: string | null;
    remainingAmount: string;
  };
  lines: BillLine[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [billOpen, setBillOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [acceptedBy, setAcceptedBy] = useState("");
  const [mode, setMode] = useState<Mode>("remaining");
  const [percent, setPercent] = useState("50");
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [invoiceDate, setInvoiceDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const fmt = (v: Decimal | string) => formatMoney(v, { currency: estimate.currency });
  const live = estimate.status === "pending" || estimate.status === "accepted";
  const billable = live && money(estimate.remainingAmount).gt(0);
  const open = lines.filter((l) => !money(l.remaining).isZero());

  function amountFor(l: BillLine): Decimal {
    if (mode === "remaining") return money(l.remaining);
    if (mode === "percent") return percentOf(l, percent);
    try {
      return money(custom[l.id] || "0");
    } catch {
      return money(0);
    }
  }
  const billTotal = sumMoney(open.map(amountFor));

  function run(fn: () => Promise<{ ok: boolean; error?: string; id?: string }>, after?: (id?: string) => void) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.(r.id);
        router.refresh();
      }
    });
  }

  function bill() {
    run(
      () =>
        invoiceEstimate({
          id: estimate.id,
          invoiceDate,
          mode,
          percent: mode === "percent" ? percent : undefined,
          lines:
            mode === "custom"
              ? open.filter((l) => custom[l.id] && !money(custom[l.id]).isZero()).map((l) => ({ estimateLineId: l.id, amount: custom[l.id] }))
              : undefined,
        }),
      (id) => {
        setBillOpen(false);
        if (id) router.push(`/ar/invoices/${id}`);
      }
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {estimate.invoiceCount === 0 && estimate.status !== "closed" && (
          <Link
            href={`/ar/estimates/${estimate.id}/edit`}
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
          >
            Edit
          </Link>
        )}
        {estimate.invoiceCount === 0 && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => deleteEstimate(estimate.id), () => router.push("/ar/estimates"))}>
            Delete
          </Button>
        )}
        {estimate.status === "pending" && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setAcceptOpen(true)}>
            Accept
          </Button>
        )}
        {live && estimate.invoiceCount === 0 && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setEstimateStatus(estimate.id, "rejected"))}>
            Reject
          </Button>
        )}
        {live && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setEstimateStatus(estimate.id, "closed"))}>
            Close
          </Button>
        )}
        {(estimate.status === "closed" || estimate.status === "rejected") && money(estimate.remainingAmount).gt(0) && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => setEstimateStatus(estimate.id, estimate.acceptedDate ? "accepted" : "pending"))}
          >
            Reopen
          </Button>
        )}
        {billable && (
          <Button size="sm" disabled={pending} onClick={() => setBillOpen(true)}>
            Create invoice
          </Button>
        )}
      </div>
      {err && !billOpen && <p className="text-xs text-destructive max-w-sm text-right">{err}</p>}

      <Dialog open={acceptOpen} onOpenChange={setAcceptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept {estimate.estimateNumber}?</DialogTitle>
            <DialogDescription>Marks the quote accepted today. You can bill it any time.</DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Accepted by</Label>
            <Input value={acceptedBy} onChange={(e) => setAcceptedBy(e.target.value)} placeholder="Optional" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAcceptOpen(false)}>Cancel</Button>
            <Button disabled={pending} onClick={() => run(() => setEstimateStatus(estimate.id, "accepted", acceptedBy || undefined), () => setAcceptOpen(false))}>
              Accept
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={billOpen} onOpenChange={setBillOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Invoice {estimate.estimateNumber}</DialogTitle>
            <DialogDescription>
              Creates a draft invoice with the estimate&apos;s items, accounts, and tax rate. {fmt(estimate.remainingAmount)} is left to bill before tax.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How much to bill">
              {(
                [
                  ["remaining", "Everything left"],
                  ["percent", "A percent of each line"],
                  ["custom", "A custom amount per line"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-md border px-3 py-1.5 text-xs ${mode === m ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border text-muted-foreground hover:bg-accent"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Invoice date</Label>
                <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </div>
              {mode === "percent" && (
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Percent</Label>
                  <Input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Percent" />
                </div>
              )}
            </div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto max-h-72">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Line</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Left</th>
                    <th className="text-right font-medium px-3 py-2 w-32">This invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((l) => (
                    <tr key={l.id} className="border-t border-border">
                      <td className="px-3 py-2 text-xs">
                        <span className="font-mono text-muted-foreground mr-2">{l.lineNumber}</span>
                        {l.label}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.remaining)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {mode === "custom" ? (
                          <input
                            inputMode="decimal"
                            aria-label={`Line ${l.lineNumber} amount`}
                            value={custom[l.id] ?? ""}
                            onChange={(e) => setCustom((c) => ({ ...c, [l.id]: e.target.value }))}
                            placeholder="0.00"
                            className="w-full text-xs bg-background border border-border rounded-md px-2 py-1 text-right font-mono"
                          />
                        ) : (
                          fmt(amountFor(l))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/30">
                  <tr className="border-t-2 border-border">
                    <td colSpan={2} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Subtotal before tax</td>
                    <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{fmt(billTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {err && <p className="text-xs text-destructive">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBillOpen(false)}>Cancel</Button>
            <Button disabled={pending || !billTotal.gt(0)} onClick={bill}>
              {pending ? "Creating…" : "Create invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
