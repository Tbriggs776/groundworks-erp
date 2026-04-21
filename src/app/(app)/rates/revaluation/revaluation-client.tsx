"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { Account } from "@/lib/db/schema";
import type { FxAdjustmentSummary } from "@/lib/gl/fx-revaluation";
import { formatMoney, money } from "@/lib/money";
import { postRevaluation, previewRevaluation } from "./actions";

export function RevaluationClient({
  accounts,
  baseCurrency,
}: {
  accounts: Account[];
  baseCurrency: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [asOfDate, setAsOfDate] = useState(today);
  const [gainAcct, setGainAcct] = useState(() => {
    const fx = accounts.find((a) => a.code === "4930");
    return fx?.id ?? "";
  });
  const [lossAcct, setLossAcct] = useState(() => {
    const fx = accounts.find((a) => a.code === "7400");
    return fx?.id ?? "";
  });
  const [autoReverseDate, setAutoReverseDate] = useState("");
  const [summary, setSummary] = useState<FxAdjustmentSummary | null>(null);

  const postingAccounts = accounts.filter(
    (a) => a.accountType === "posting" && a.isActive && !a.isBlocked
  );

  function preview() {
    setErr(null);
    start(async () => {
      try {
        const s = await previewRevaluation(asOfDate);
        setSummary(s);
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  }

  function post() {
    setErr(null);
    start(async () => {
      const r = await postRevaluation({
        asOfDate,
        fxGainAccountId: gainAcct,
        fxLossAccountId: lossAcct,
        autoReverseDate: autoReverseDate || undefined,
      });
      if (r.ok) {
        router.push(`/gl/${r.journalId}`);
      } else {
        setErr(r.error);
        if (r.summary) setSummary(r.summary);
      }
    });
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-4 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Revaluation date
          </Label>
          <Input
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Auto-reverse on (optional)
          </Label>
          <Input
            type="date"
            value={autoReverseDate}
            onChange={(e) => setAutoReverseDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            FX Gain account
          </Label>
          <select
            value={gainAcct}
            onChange={(e) => setGainAcct(e.target.value)}
            className="w-full text-sm bg-background border border-border rounded-md px-2 py-2"
          >
            <option value="">— choose account —</option>
            {postingAccounts
              .filter((a) => a.normalBalance === "credit")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            FX Loss account
          </Label>
          <select
            value={lossAcct}
            onChange={(e) => setLossAcct(e.target.value)}
            className="w-full text-sm bg-background border border-border rounded-md px-2 py-2"
          >
            <option value="">— choose account —</option>
            {postingAccounts
              .filter((a) => a.normalBalance === "debit")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={preview} disabled={pending}>
          {pending ? "Working…" : "Preview adjustments"}
        </Button>
        <Button
          onClick={post}
          disabled={
            pending ||
            !summary ||
            !gainAcct ||
            !lossAcct ||
            summary.adjustments.length === 0 ||
            summary.missingRates.length > 0
          }
        >
          {pending ? "Posting…" : "Post revaluation"}
        </Button>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      {summary && (
        <div className="space-y-3">
          {summary.missingRates.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
              <div className="font-semibold text-destructive uppercase tracking-wider mb-1">
                Missing rates
              </div>
              <div className="text-xs">
                {summary.missingRates
                  .map((m) => `${m.fromCurrency} → ${m.toCurrency}`)
                  .join(", ")}
                . Add spot rates for {asOfDate} on the Exchange Rates screen.
              </div>
            </div>
          )}

          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2 w-24">
                    Account
                  </th>
                  <th className="text-left font-medium px-3 py-2">Name</th>
                  <th className="text-left font-medium px-3 py-2 w-16">CCY</th>
                  <th className="text-right font-medium px-3 py-2 w-32">
                    Foreign bal
                  </th>
                  <th className="text-right font-medium px-3 py-2 w-28">Rate</th>
                  <th className="text-right font-medium px-3 py-2 w-36">
                    Book ({baseCurrency})
                  </th>
                  <th className="text-right font-medium px-3 py-2 w-36">
                    New ({baseCurrency})
                  </th>
                  <th className="text-right font-medium px-3 py-2 w-32">
                    Adjustment
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.adjustments.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-8 text-center text-xs text-muted-foreground"
                    >
                      No adjustments needed.
                    </td>
                  </tr>
                )}
                {summary.adjustments.map((a) => (
                  <tr key={`${a.accountId}-${a.currency}`} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono text-xs text-primary">
                      {a.accountCode}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{a.accountName}</td>
                    <td className="px-3 py-1.5">
                      <Badge variant="secondary" className="text-[9px]">
                        {a.currency}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs">
                      {a.foreignBalance.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                      {a.currentRate.toFixed(6)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                      {formatMoney(a.bookLocalBalance, {
                        currency: baseCurrency,
                      })}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs">
                      {formatMoney(a.newLocalValue, { currency: baseCurrency })}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono text-xs font-semibold ${
                        a.adjustment.gt(0)
                          ? "text-[var(--gw-green-bright)]"
                          : "text-destructive"
                      }`}
                    >
                      {a.adjustment.gt(0) ? "+" : ""}
                      {formatMoney(a.adjustment, { currency: baseCurrency })}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 border-t-2 border-border">
                  <td
                    colSpan={7}
                    className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground text-right"
                  >
                    Net adjustment (net gain ↑ / net loss ↓)
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-sm font-semibold ${
                      summary.netAdjustment.gt(0)
                        ? "text-[var(--gw-green-bright)]"
                        : summary.netAdjustment.lt(0)
                        ? "text-destructive"
                        : ""
                    }`}
                  >
                    {summary.netAdjustment.gt(0) ? "+" : ""}
                    {formatMoney(summary.netAdjustment, {
                      currency: baseCurrency,
                    })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="text-[11px] text-muted-foreground">
            The posted JE will debit/credit each account by the adjustment
            above, with a single offsetting line to the{" "}
            {summary.netAdjustment.gte(0) ? "FX Gain" : "FX Loss"} account for{" "}
            {formatMoney(money(summary.netAdjustment).abs(), {
              currency: baseCurrency,
            })}
            .
          </p>
        </div>
      )}
    </div>
  );
}
