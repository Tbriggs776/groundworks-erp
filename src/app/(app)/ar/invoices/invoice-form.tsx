"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addDays, format, parseISO } from "date-fns";
import Decimal from "decimal.js";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Account, ArInvoice, ArInvoiceLine, Customer, Item } from "@/lib/db/schema";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { saveInvoice, type InvoiceInput } from "./actions";

type Line = {
  key: string;
  itemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
};

const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5";

function blankLine(): Line {
  return { key: crypto.randomUUID(), itemId: "", description: "", quantity: "1", unitPrice: "", accountId: "" };
}

/** Same rounding the server applies: qty × price, half-up to cents. */
function lineAmount(l: Line): Decimal {
  try {
    return money(l.quantity || "0")
      .times(money(l.unitPrice || "0"))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } catch {
    return money(0);
  }
}

export function InvoiceForm({
  customers,
  items,
  incomeAccounts,
  initial,
  initialLines,
  defaultCustomerId,
}: {
  customers: Customer[];
  items: Item[];
  incomeAccounts: Account[];
  initial?: ArInvoice;
  initialLines?: ArInvoiceLine[];
  defaultCustomerId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const today = format(new Date(), "yyyy-MM-dd");

  const [customerId, setCustomerId] = useState(initial?.customerId ?? defaultCustomerId ?? "");
  const [invoiceDate, setInvoiceDate] = useState(initial?.invoiceDate ?? today);
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [poNumber, setPoNumber] = useState(initial?.poNumber ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [privateNote, setPrivateNote] = useState(initial?.privateNote ?? "");
  const [lines, setLines] = useState<Line[]>(
    initialLines?.length
      ? initialLines.map((l) => ({
          key: crypto.randomUUID(),
          itemId: l.itemId ?? "",
          description: l.description ?? "",
          quantity: money(l.quantity).toString(),
          unitPrice: money(l.unitPrice).toFixed(2),
          accountId: l.accountId,
        }))
      : [blankLine()]
  );

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const customer = customers.find((c) => c.id === customerId);
  const currency = customer?.currency ?? "USD";
  const total = sumMoney(lines.map(lineAmount));
  const suggestedDue =
    customer && invoiceDate
      ? format(addDays(parseISO(invoiceDate), customer.defaultPaymentTermsDays), "yyyy-MM-dd")
      : "";

  function update(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: string, itemId: string) {
    const item = itemById.get(itemId);
    update(key, {
      itemId,
      description: item?.description ?? item?.name ?? "",
      unitPrice: item?.salesPrice ? money(item.salesPrice).toFixed(2) : "",
      accountId: item?.incomeAccountId ?? "",
    });
  }

  function submit(post: boolean) {
    setErr(null);
    start(async () => {
      const payload: InvoiceInput = {
        customerId,
        invoiceDate,
        dueDate: dueDate || undefined,
        poNumber,
        memo,
        privateNote,
        lines: lines
          .filter((l) => l.itemId || l.accountId)
          .map((l) => ({
            itemId: l.itemId || undefined,
            accountId: l.accountId || undefined,
            description: l.description,
            quantity: l.quantity || "1",
            unitPrice: l.unitPrice || undefined,
          })),
      };
      const r = await saveInvoice(initial?.id ?? null, payload, post);
      if (r.ok) router.push(`/ar/invoices/${r.id}`);
      else setErr(r.error);
    });
  }

  const canSave = !pending && customerId && invoiceDate && total.gt(0);

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Customer</Label>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={`${cell} text-sm py-2`}>
            <option value="">— choose customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {customer?.email && (
            <p className="text-[11px] text-muted-foreground mt-1">{customer.email}</p>
          )}
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Invoice date</Label>
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Due date</Label>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          {!dueDate && suggestedDue && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Net {customer?.defaultPaymentTermsDays}: {suggestedDue}
            </p>
          )}
        </div>
      </div>

      <div className="max-w-xs">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Customer PO #</Label>
        <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
      </div>

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-8"></th>
              <th className="text-left font-medium px-3 py-2 w-44">Product / service</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
              <th className="text-right font-medium px-3 py-2 w-28">Rate</th>
              <th className="text-right font-medium px-3 py-2 w-28">Amount</th>
              <th className="text-left font-medium px-3 py-2 w-40">Income account</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={l.key} className="border-t border-border align-top">
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{idx + 1}</td>
                <td className="px-3 py-2">
                  <select value={l.itemId} onChange={(e) => pickItem(l.key, e.target.value)} className={cell}>
                    <option value="">— none —</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} className={cell} />
                </td>
                <td className="px-3 py-2">
                  <input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} className={`${cell} text-right font-mono`} />
                </td>
                <td className="px-3 py-2">
                  <input inputMode="decimal" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} className={`${cell} text-right font-mono`} placeholder="0.00" />
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs pt-3.5">
                  {formatMoney(lineAmount(l), { currency })}
                </td>
                <td className="px-3 py-2">
                  <select value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })} className={cell}>
                    <option value="">{l.itemId ? "(from item)" : "— choose —"}</option>
                    {incomeAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setLines((p) => (p.length > 1 ? p.filter((x) => x.key !== l.key) : p))}
                    disabled={lines.length <= 1}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30 pt-1.5"
                    aria-label="Remove line"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30 border-t-2 border-border">
              <td colSpan={5} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                Total
              </td>
              <td className="px-3 py-2 text-right font-mono text-sm font-semibold">
                {formatMoney(total, { currency })}
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, blankLine()])}>
        <Plus className="h-3.5 w-3.5" />
        Add line
      </Button>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Message on invoice</Label>
          <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} placeholder="Thank you for your business." />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Private note</Label>
          <Textarea value={privateNote} onChange={(e) => setPrivateNote(e.target.value)} rows={3} placeholder="Internal only" />
        </div>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
        <Button onClick={() => submit(true)} disabled={!canSave}>
          {pending ? "Saving…" : "Save and post"}
        </Button>
        <Button variant="outline" onClick={() => submit(false)} disabled={!canSave}>
          Save draft
        </Button>
        <Button variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Posting finalizes the invoice: Dr Accounts Receivable, Cr income.
        </p>
      </div>
    </div>
  );
}
