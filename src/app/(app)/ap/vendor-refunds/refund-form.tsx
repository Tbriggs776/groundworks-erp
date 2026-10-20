"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { saveVendorRefund } from "../ap-actions";

type Credit = { id: string; number: string; remaining: string };
const cell = "w-full text-sm bg-background border border-border rounded-md px-2 py-2";
const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";
const METHODS = [
  ["check", "Check"],
  ["ach", "ACH"],
  ["wire", "Wire"],
  ["credit_card", "Card refund"],
  ["cash", "Cash"],
  ["other", "Other"],
] as const;

/** Money a vendor sends back for a credit. */
export function VendorRefundForm({
  vendors,
  creditsByVendor,
  accounts,
  defaults,
}: {
  vendors: Array<{ id: string; name: string; currency: string }>;
  creditsByVendor: Record<string, Credit[]>;
  accounts: Array<{ id: string; code: string; name: string }>;
  defaults: { vendorId?: string; vendorCreditId?: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(defaults.vendorId ?? "");
  const [vendorCreditId, setVendorCreditId] = useState(defaults.vendorCreditId ?? "");
  const credits = creditsByVendor[vendorId] ?? [];
  const available = vendorCreditId ? money(credits.find((c) => c.id === vendorCreditId)?.remaining ?? "0") : sumMoney(credits.map((c) => c.remaining));
  const [amount, setAmount] = useState("");
  const [refundDate, setRefundDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [bankAccountId, setBankAccountId] = useState(accounts.find((a) => a.code === "1010")?.id ?? accounts[0]?.id ?? "");
  const [method, setMethod] = useState<string>("check");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const currency = vendors.find((v) => v.id === vendorId)?.currency ?? "USD";

  function submit(post: boolean) {
    setErr(null);
    start(async () => {
      const r = await saveVendorRefund(
        {
          vendorId,
          vendorCreditId: vendorCreditId || undefined,
          amount: amount || available.toFixed(2),
          refundDate,
          bankAccountId,
          method: method as "check",
          reference,
          memo,
        },
        post
      );
      if (r.ok) router.push(`/ap/vendor-refunds/${r.id}`);
      else setErr(r.error);
    });
  }

  if (vendors.length === 0) {
    return <p className="text-sm text-muted-foreground">No vendor has unused credit right now. Record a vendor credit first.</p>;
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className={label}>Vendor</Label>
          <select
            value={vendorId}
            onChange={(e) => {
              setVendorId(e.target.value);
              setVendorCreditId("");
            }}
            className={cell}
            aria-label="Vendor"
          >
            <option value="">Choose vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className={label}>Credit being refunded</Label>
          <select value={vendorCreditId} onChange={(e) => setVendorCreditId(e.target.value)} className={cell} aria-label="Credit">
            <option value="">Oldest credits first</option>
            {credits.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} · {formatMoney(c.remaining, { currency })} left
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div>
          <Label className={label}>Amount</Label>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={available.toFixed(2)} aria-label="Amount" />
        </div>
        <div>
          <Label className={label}>Date received</Label>
          <Input type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)} />
        </div>
        <div>
          <Label className={label}>Deposit to</Label>
          <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className={cell} aria-label="Deposit to">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className={label}>Method</Label>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={cell} aria-label="Method">
            {METHODS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className={label}>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Their check #, optional" />
        </div>
        <div>
          <Label className={label}>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
        <Button onClick={() => submit(true)} disabled={pending || !vendorId || !bankAccountId}>
          {pending ? "Saving…" : "Save and post"}
        </Button>
        <Button variant="outline" onClick={() => submit(false)} disabled={pending || !vendorId || !bankAccountId}>
          Save draft
        </Button>
        <p className="text-[11px] text-muted-foreground">Posting records it: Dr the deposit account, Cr Accounts Payable, and uses the vendor credit.</p>
      </div>
    </div>
  );
}
