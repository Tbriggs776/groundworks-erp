"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatMoney, money } from "@/lib/money";
import { applyVendorCredit, unapplyVendorCredit } from "./ap-actions";

const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.();
        router.refresh();
      }
    });
  };
  return { pending, err, run };
}

/** On a vendor credit: pay down one of the vendor's open bills. */
export function ApplyToBill({
  vendorCreditId,
  remaining,
  currency,
  bills,
}: {
  vendorCreditId: string;
  remaining: string;
  currency: string;
  bills: Array<{ id: string; number: string; dueDate: string; openBalance: string }>;
}) {
  const { pending, err, run } = useRun();
  const [billId, setBillId] = useState(bills[0]?.id ?? "");
  const bill = bills.find((b) => b.id === billId);
  const max = bill ? (money(bill.openBalance).lt(money(remaining)) ? money(bill.openBalance) : money(remaining)) : money(0);
  const [amount, setAmount] = useState("");
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Apply to a bill</div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={billId} onChange={(e) => setBillId(e.target.value)} className={`${cell} max-w-xs`} aria-label="Bill">
          {bills.map((b) => (
            <option key={b.id} value={b.id}>
              {b.number} · due {b.dueDate} · {formatMoney(b.openBalance, { currency })} open
            </option>
          ))}
        </select>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={max.toFixed(2)}
          className={`${cell} w-28 text-right font-mono`}
          aria-label="Amount to apply"
        />
        <Button size="sm" disabled={pending || !billId} onClick={() => run(() => applyVendorCredit({ vendorCreditId, billId, amount: amount || undefined }), () => setAmount(""))}>
          Apply
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

/** On a bill: pay it down with one of the vendor's credits. */
export function UseVendorCredit({
  billId,
  openBalance,
  currency,
  credits,
}: {
  billId: string;
  openBalance: string;
  currency: string;
  credits: Array<{ id: string; number: string; remaining: string }>;
}) {
  const { pending, err, run } = useRun();
  const [creditId, setCreditId] = useState(credits[0]?.id ?? "");
  const credit = credits.find((c) => c.id === creditId);
  const max = credit ? (money(credit.remaining).lt(money(openBalance)) ? money(credit.remaining) : money(openBalance)) : money(0);
  const [amount, setAmount] = useState("");
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="text-xs">This vendor has credit you can use on this bill.</div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={creditId} onChange={(e) => setCreditId(e.target.value)} className={`${cell} max-w-xs`} aria-label="Vendor credit">
          {credits.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number} · {formatMoney(c.remaining, { currency })} left
            </option>
          ))}
        </select>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={max.toFixed(2)}
          className={`${cell} w-28 text-right font-mono`}
          aria-label="Amount to apply"
        />
        <Button size="sm" disabled={pending || !creditId} onClick={() => run(() => applyVendorCredit({ vendorCreditId: creditId, billId, amount: amount || undefined }), () => setAmount(""))}>
          Use credit
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

/** Where a vendor credit went (or which credits a bill used), with unapply. */
export function VendorCreditUses({
  uses,
  currency,
  show,
}: {
  uses: Array<{
    applicationId: string;
    vendorCreditId: string;
    creditNumber: string;
    billId: string | null;
    billNumber: string | null;
    vendorRefundId: string | null;
    refundNumber: string | null;
    amount: string;
    appliedOn: string;
  }>;
  currency: string;
  /** "target": list the bills / refunds (on a credit). "credit": list the credits (on a bill). */
  show: "target" | "credit";
}) {
  const { pending, err, run } = useRun();
  if (uses.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{show === "target" ? "Credit used" : "Vendor credits applied"}</div>
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {uses.map((u) => (
              <tr key={u.applicationId} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2 font-mono text-xs">
                  {show === "credit" ? (
                    <Link href={`/ap/vendor-credits/${u.vendorCreditId}`} className="text-primary hover:underline">{u.creditNumber}</Link>
                  ) : u.billId ? (
                    <Link href={`/ap/bills/${u.billId}`} className="text-primary hover:underline">{u.billNumber}</Link>
                  ) : (
                    <Link href={`/ap/vendor-refunds/${u.vendorRefundId}`} className="text-primary hover:underline">{u.refundNumber}</Link>
                  )}
                </td>
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{u.appliedOn}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(u.amount, { currency })}</td>
                <td className="px-3 py-2 text-right w-24">
                  {u.billId && (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unapplyVendorCredit(u.applicationId))}>
                      Unapply
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
