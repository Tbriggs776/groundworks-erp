"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Account, Customer } from "@/lib/db/schema";
import { formatMoney, money, sumMoney } from "@/lib/money";
import {
  openInvoicesFor,
  receivePayment,
  type OpenInvoice,
  type ReceivePaymentInput,
} from "../actions";

const METHODS = [
  ["check", "Check"],
  ["ach", "ACH / bank transfer"],
  ["credit_card", "Credit card"],
  ["wire", "Wire"],
  ["cash", "Cash"],
  ["other", "Other"],
] as const;

const field = "w-full text-sm bg-background border border-border rounded-md px-2 py-2";
const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-right font-mono";

type Apply = { amount: string; discount: string };

export function ReceivePaymentForm({
  customers,
  depositAccounts,
  defaultCustomerId,
  defaultInvoiceId,
}: {
  customers: Customer[];
  depositAccounts: Account[];
  defaultCustomerId?: string;
  defaultInvoiceId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [loading, startLoading] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");
  const [paymentDate, setPaymentDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [method, setMethod] = useState<ReceivePaymentInput["method"]>("check");
  const [reference, setReference] = useState("");
  const [depositAccountId, setDepositAccountId] = useState(
    (depositAccounts.find((a) => a.code === "1250") ?? depositAccounts[0])?.id ?? ""
  );
  const [memo, setMemo] = useState("");
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [apply, setApply] = useState<Record<string, Apply>>({});

  useEffect(() => {
    if (!customerId) return;
    startLoading(async () => {
      const r = await openInvoicesFor(customerId);
      const rows = r.ok ? r.invoices : [];
      setInvoices(rows);
      // Coming from an invoice's "Receive payment": prefill its balance.
      setApply(
        Object.fromEntries(
          rows.map((i) => [
            i.id,
            {
              amount: i.id === defaultInvoiceId ? money(i.openBalance).toFixed(2) : "",
              discount: "",
            },
          ])
        )
      );
    });
  }, [customerId, defaultInvoiceId]);

  const applied = invoices.filter((i) => money(apply[i.id]?.amount || "0").gt(0));
  const total = sumMoney(applied.map((i) => apply[i.id].amount));
  const customer = customers.find((c) => c.id === customerId);
  const currency = customer?.currency ?? "USD";

  function setRow(id: string, patch: Partial<Apply>) {
    setApply((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function payAll() {
    setApply(
      Object.fromEntries(
        invoices.map((i) => [i.id, { amount: money(i.openBalance).toFixed(2), discount: "" }])
      )
    );
  }

  function submit(post: boolean) {
    setErr(null);
    start(async () => {
      const r = await receivePayment({
        customerId,
        paymentDate,
        method,
        reference,
        depositAccountId,
        memo,
        applications: applied.map((i) => ({
          invoiceId: i.id,
          amount: apply[i.id].amount,
          discountAmount: apply[i.id].discount || "0",
        })),
        post,
      });
      if (r.ok) router.push(`/ar/payments/${r.id}`);
      else setErr(r.error);
    });
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Customer</Label>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={field}>
            <option value="">— choose customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Payment date</Label>
          <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Deposit to</Label>
          <select value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)} className={field}>
            {depositAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Method</Label>
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className={field}>
            {METHODS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Reference #</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check #" />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
      </div>

      {customerId && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Open invoices {loading && "· loading…"}
            </div>
            {invoices.length > 0 && (
              <Button size="sm" variant="ghost" onClick={payAll}>
                Pay all in full
              </Button>
            )}
          </div>
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2 w-28">Invoice #</th>
                  <th className="text-left font-medium px-3 py-2 w-28">Due</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Balance</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Payment</th>
                  <th className="text-right font-medium px-3 py-2 w-28">Discount</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 && !loading && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-xs text-muted-foreground">
                      No open invoices for this customer.
                    </td>
                  </tr>
                )}
                {invoices.map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{i.invoiceNumber}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{i.dueDate}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(i.openBalance, { currency })}</td>
                    <td className="px-3 py-2">
                      <input inputMode="decimal" value={apply[i.id]?.amount ?? ""} onChange={(e) => setRow(i.id, { amount: e.target.value })} className={cell} placeholder="0.00" />
                    </td>
                    <td className="px-3 py-2">
                      <input inputMode="decimal" value={apply[i.id]?.discount ?? ""} onChange={(e) => setRow(i.id, { discount: e.target.value })} className={cell} placeholder="0.00" />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 border-t-2 border-border">
                  <td colSpan={3} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                    Amount received
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm font-semibold">
                    {formatMoney(total, { currency })}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
        <Button onClick={() => submit(true)} disabled={pending || applied.length === 0 || !depositAccountId}>
          {pending ? "Saving…" : "Save and post"}
        </Button>
        <Button variant="outline" onClick={() => submit(false)} disabled={pending || applied.length === 0 || !depositAccountId}>
          Save draft
        </Button>
        <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
      </div>
    </div>
  );
}
