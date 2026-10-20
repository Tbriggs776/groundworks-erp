"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, CheckCircle2 } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import type { ReviewItem } from "@/lib/review";
import { approveItem, dismissItem } from "./actions";

const TYPE_LABEL: Record<ReviewItem["type"], string> = {
  invoice: "Invoice",
  customer_payment: "Payment received",
  sales_receipt: "Sales receipt",
  credit_memo: "Credit memo",
  refund_receipt: "Refund",
  bill: "Bill",
  bill_payment: "Bill payment",
  journal_entry: "Journal entry",
  bank_transaction: "Bank transaction",
};

function approveLabel(item: ReviewItem): string {
  if (item.type === "bill") return item.status === "approved" ? "Post" : "Approve & post";
  return "Post";
}

export function ReviewClient({ items }: { items: ReviewItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function act(item: ReviewItem, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(item.id);
    setErrors((e) => ({ ...e, [item.id]: "" }));
    start(async () => {
      const r = await fn();
      if (!r.ok) setErrors((e) => ({ ...e, [item.id]: r.error ?? "Failed." }));
      setBusy(null);
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <div className="max-w-xl rounded-md border border-border p-8 text-center space-y-2">
        <CheckCircle2 className="h-6 w-6 mx-auto text-primary" />
        <div className="text-sm">Nothing waiting on you.</div>
        <div className="text-xs text-muted-foreground">
          Drafts that agents create, and bills awaiting approval, show up here.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-6xl">
      <p className="text-xs text-muted-foreground">
        {items.length} item{items.length === 1 ? "" : "s"} waiting. Posting runs every normal check (balances,
        periods, approval thresholds) under your name.
      </p>
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">Document</th>
              <th className="text-left font-medium px-3 py-2">From</th>
              <th className="text-left font-medium px-3 py-2 w-28">Date</th>
              <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              <th className="text-left font-medium px-3 py-2 w-32">Status</th>
              <th className="w-56"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.type}-${item.id}`} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <Link href={item.href} className="font-mono text-xs text-primary hover:underline">
                    {item.number}
                  </Link>
                  <div className="text-[11px] text-muted-foreground">
                    {TYPE_LABEL[item.type]}
                    {item.party ? ` · ${item.party}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {item.agentName ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px]">
                      <Bot className="h-3 w-3" />
                      {item.agentName}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{item.reason === "recurring" ? "Recurring invoice" : "Awaiting approval"}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{item.date}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(item.amount, { currency: item.currency })}
                </td>
                <td className="px-3 py-2"><StatusBadge status={item.status} /></td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending && busy === item.id}
                      onClick={() => act(item, () => dismissItem(item.type, item.id, item.status))}
                    >
                      {item.type === "bill" && item.status === "pending_approval" ? "Reject" : "Discard"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={pending && busy === item.id}
                      onClick={() => act(item, () => approveItem(item.type, item.id, item.status))}
                    >
                      {approveLabel(item)}
                    </Button>
                  </div>
                  {errors[item.id] && (
                    <div className="text-[11px] text-destructive mt-1 text-right max-w-xs ml-auto">{errors[item.id]}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
