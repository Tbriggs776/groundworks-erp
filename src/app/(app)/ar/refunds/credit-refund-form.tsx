"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomerCredit } from "@/lib/ar/credits";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { customerCredits, saveRefund } from "../sales-actions";

const cell = "w-full text-sm bg-background border border-border rounded-md px-2 py-2";

/** Pay a customer's credit balance back to them. */
export function CreditRefundForm({
  customers,
  bankAccounts,
  defaultCustomerId,
  defaultCreditId,
}: {
  customers: Array<{ id: string; name: string; currency: string }>;
  bankAccounts: Array<{ id: string; code: string; name: string }>;
  defaultCustomerId?: string;
  defaultCreditId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");
  const [credits, setCredits] = useState<CustomerCredit[]>([]);
  const [creditId, setCreditId] = useState(defaultCreditId ?? "");
  const [amount, setAmount] = useState("");
  const [refundDate, setRefundDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [method, setMethod] = useState("check");
  const [reference, setReference] = useState("");
  const [bankAccountId, setBankAccountId] = useState(bankAccounts.find((a) => a.code === "1010")?.id ?? bankAccounts[0]?.id ?? "");
  const currency = customers.find((c) => c.id === customerId)?.currency ?? "USD";

  useEffect(() => {
    if (!customerId) return;
    let live = true;
    customerCredits(customerId).then((r) => {
      if (!live) return;
      const list = r.ok ? r.credits : [];
      setCredits(list);
      const chosen = list.find((c) => c.id === creditId);
      setAmount(money(chosen?.remaining ?? sumMoney(list.map((c) => c.remaining))).toFixed(2));
    });
    return () => {
      live = false;
    };
    // Reload when the customer changes; the credit choice sets the amount below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const available = sumMoney(credits.map((c) => c.remaining));
  const chosen = credits.find((c) => c.id === creditId);

  function save(post: boolean) {
    setErr(null);
    start(async () => {
      const r = await saveRefund(
        {
          kind: "credit",
          customerId,
          refundDate,
          method: method as "check",
          reference: reference || undefined,
          bankAccountId,
          amount,
          creditMemoId: chosen?.kind === "credit_memo" ? chosen.id : undefined,
          paymentId: chosen?.kind === "payment" ? chosen.id : undefined,
        },
        post
      );
      if (r.ok) router.push(`/ar/refunds/${r.id}`);
      else setErr(r.error);
    });
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Customer</Label>
          <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setCreditId(""); }} className={cell}>
            <option value="">Choose customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {customerId && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {credits.length === 0 ? "No unused credit." : `${formatMoney(available, { currency })} in unused credit.`}
            </p>
          )}
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Credit to pay out</Label>
          <select
            value={creditId}
            onChange={(e) => {
              setCreditId(e.target.value);
              const c = credits.find((x) => x.id === e.target.value);
              setAmount(money(c?.remaining ?? available).toFixed(2));
            }}
            className={cell}
            disabled={credits.length === 0}
          >
            <option value="">Oldest credits first</option>
            {credits.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} ({c.kind === "credit_memo" ? "credit memo" : "overpayment"}) · {formatMoney(c.remaining, { currency })} left
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Amount</Label>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono text-right" />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Refund date</Label>
          <Input type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Method</Label>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={cell}>
            <option value="check">Check</option>
            <option value="ach">ACH</option>
            <option value="credit_card">Credit card</option>
            <option value="cash">Cash</option>
            <option value="wire">Wire</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Check #</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      <div className="max-w-sm">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Refund from</Label>
        <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className={cell}>
          {bankAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
          ))}
        </select>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
        <Button onClick={() => save(true)} disabled={pending || !customerId || !money(amount || "0").gt(0)}>
          {pending ? "Saving…" : "Save and post"}
        </Button>
        <Button variant="outline" onClick={() => save(false)} disabled={pending || !customerId || !money(amount || "0").gt(0)}>
          Save draft
        </Button>
        <p className="text-[11px] text-muted-foreground">Posting pays it out: Dr Accounts Receivable, Cr the bank account, and uses up the credit.</p>
      </div>
    </div>
  );
}
