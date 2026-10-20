"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney, money } from "@/lib/money";
import { applyCredit, unapplyCredit } from "./sales-actions";

/** Pay down one of the customer's open invoices with this credit. */
export function ApplyCredit({
  source,
  remaining,
  currency,
  invoices,
}: {
  source: { creditMemoId: string } | { paymentId: string };
  remaining: string;
  currency: string;
  invoices: Array<{ id: string; number: string; dueDate: string; openBalance: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [invoiceId, setInvoiceId] = useState(invoices[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const inv = invoices.find((i) => i.id === invoiceId);
  const max = inv ? (money(inv.openBalance).lt(money(remaining)) ? money(inv.openBalance) : money(remaining)) : money(0);
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Apply to an open invoice</div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} className="text-xs bg-background border border-border rounded-md px-2 py-1.5" aria-label="Invoice">
          {invoices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.number} · due {i.dueDate} · {formatMoney(i.openBalance, { currency })} open
            </option>
          ))}
        </select>
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={max.toFixed(2)} className="w-32 font-mono text-right" />
        <Button
          size="sm"
          disabled={pending || !invoiceId}
          onClick={() =>
            start(async () => {
              setErr(null);
              const r = await applyCredit({ ...source, invoiceId, amount: amount || undefined });
              if (!r.ok) setErr(r.error);
              else {
                setAmount("");
                router.refresh();
              }
            })
          }
        >
          Apply
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

/** Where a credit went: invoices it paid (can be unapplied) and refunds that paid it out. */
export function CreditUses({
  uses,
  currency,
  title = "Credit used",
}: {
  uses: Array<{
    id: string;
    amount: string;
    appliedOn: string;
    automatic: boolean;
    invoiceId: string | null;
    refundId: string | null;
    targetNumber: string;
    href?: string;
    label?: string;
    canUnapply?: boolean;
  }>;
  currency: string;
  title?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  if (uses.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{title}</div>
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {uses.map((u) => (
              <tr key={u.id} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2 font-mono text-xs">
                  <Link href={u.href ?? (u.invoiceId ? `/ar/invoices/${u.invoiceId}` : `/ar/refunds/${u.refundId}`)} className="text-primary hover:underline">{u.targetNumber}</Link>
                  <span className="text-muted-foreground"> · {u.label ?? (u.invoiceId ? "invoice" : "refund")}{u.automatic ? " · automatic" : ""}</span>
                </td>
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{u.appliedOn}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(u.amount, { currency })}</td>
                <td className="px-3 py-2 text-right w-28">
                  {(u.canUnapply ?? Boolean(u.invoiceId)) && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          setErr(null);
                          const r = await unapplyCredit(u.id);
                          if (!r.ok) setErr(r.error);
                          router.refresh();
                        })
                      }
                    >
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

/** On an open invoice: use one of the customer's credits. */
export function UseCredit({
  invoiceId,
  credits,
  openBalance,
  currency,
}: {
  invoiceId: string;
  credits: Array<{ kind: "credit_memo" | "payment"; id: string; number: string; remaining: string }>;
  openBalance: string;
  currency: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [creditId, setCreditId] = useState(credits[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const credit = credits.find((c) => c.id === creditId);
  const amount = credit ? (money(credit.remaining).lt(money(openBalance)) ? money(credit.remaining) : money(openBalance)) : money(0);
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="text-xs">This customer has unused credit.</div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={creditId} onChange={(e) => setCreditId(e.target.value)} className="text-xs bg-background border border-border rounded-md px-2 py-1.5" aria-label="Credit">
          {credits.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number} ({c.kind === "credit_memo" ? "credit memo" : "overpayment"}) · {formatMoney(c.remaining, { currency })} left
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={pending || !credit}
          onClick={() =>
            start(async () => {
              setErr(null);
              const r = await applyCredit({
                invoiceId,
                creditMemoId: credit?.kind === "credit_memo" ? credit.id : undefined,
                paymentId: credit?.kind === "payment" ? credit.id : undefined,
              });
              if (!r.ok) setErr(r.error);
              router.refresh();
            })
          }
        >
          Apply {formatMoney(amount, { currency })}
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

/** Credits applied to an invoice, each with Unapply. */
export function CreditsOnInvoice({
  credits,
  currency,
}: {
  credits: Array<{ id: string; amount: string; appliedOn: string; automatic: boolean; creditMemoId: string | null; paymentId: string | null; creditNumber: string }>;
  currency: string;
}) {
  return (
    <CreditUses
      currency={currency}
      uses={credits.map((c) => ({
        id: c.id,
        amount: c.amount,
        appliedOn: c.appliedOn,
        automatic: c.automatic,
        invoiceId: null,
        refundId: null,
        targetNumber: c.creditNumber,
        href: c.creditMemoId ? `/ar/credit-memos/${c.creditMemoId}` : `/ar/payments/${c.paymentId}`,
        label: c.creditMemoId ? "credit memo" : "overpayment",
        canUnapply: true,
      }))}
      title="Credits applied"
    />
  );
}
