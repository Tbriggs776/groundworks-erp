"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import type { Tieout } from "@/lib/qbo/tieout";
import { compareWithQuickBooks, postTieout } from "./actions";

/**
 * The tie-out: each month whose activity differs from QuickBooks' books,
 * and the conversion entry that closes it. Compares on its own the first
 * time the finished import's page opens.
 */
export function TieoutPanel({ initial, canRun, connected }: { initial: Tieout; canRun: boolean; connected: boolean }) {
  const [t, setT] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const started = useRef(false);

  const run = (fn: () => Promise<{ ok: true; tieout: Tieout } | { ok: false; error: string }>) =>
    start(async () => {
      setErr(null);
      const r = await fn();
      if (r.ok) setT(r.tieout);
      else setErr(r.error);
    });

  useEffect(() => {
    if (started.current || initial.ready || !canRun || !connected) return;
    started.current = true;
    const timer = setTimeout(() => run(() => compareWithQuickBooks()), 0);
    return () => clearTimeout(timer);
    // Compare once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const money = (v: string) => formatMoney(v);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold">Tie-out with QuickBooks</div>
          <p className="text-sm text-muted-foreground">
            {!t.ready
              ? pending
                ? "Reading QuickBooks' books month by month…"
                : "Compare the books here with QuickBooks' balance sheet and profit and loss, month by month."
              : t.months.length === 0
                ? `All ${t.monthsCompared} months tie to QuickBooks.`
                : `${t.monthsCompared - t.months.length} of ${t.monthsCompared} months tie to QuickBooks. The rest differ below; a conversion entry on each month's last day closes the difference.`}
          </p>
        </div>
        {canRun && (
          <div className="flex gap-2">
            {connected && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => compareWithQuickBooks())}>
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t.ready ? "Compare again" : "Compare with QuickBooks"}
              </Button>
            )}
            {t.months.some((m) => m.postable) && (
              <Button size="sm" disabled={pending} onClick={() => run(() => postTieout())}>
                Post all entries
              </Button>
            )}
          </div>
        )}
      </div>

      {err && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">{err}</div>}

      {t.months.map((m) => (
        <div key={m.month} className="rounded-lg border border-border overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/50 px-3 py-2">
            <div className="text-sm font-medium">{m.label}</div>
            {canRun && m.postable && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => postTieout(m.month))}>
                Post conversion entry
              </Button>
            )}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-1.5">Account</th>
                <th className="text-right font-medium px-3 py-1.5 w-28">Here</th>
                <th className="text-right font-medium px-3 py-1.5 w-28">QuickBooks</th>
                <th className="text-right font-medium px-3 py-1.5 w-28">Difference</th>
              </tr>
            </thead>
            <tbody>
              {m.lines.map((l) => (
                <tr key={`${l.accountId ?? l.name}`} className="border-t border-border">
                  <td className="px-3 py-1.5">
                    {l.code ? `${l.code} ` : ""}
                    {l.name}
                    {!l.accountId && <span className="text-muted-foreground"> (didn&apos;t come across)</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">{money(l.here)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">{money(l.quickbooks)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">{money(l.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!m.postable && (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Opening Balance Equity holds what&apos;s left: amounts on QuickBooks accounts that didn&apos;t come across.
            </p>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Amounts are each account&apos;s activity in the month, on its statement side: assets and expenses as debits, liabilities, equity, and income as
        credits.
      </p>
    </div>
  );
}
