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
import { saveInvoice } from "./invoices/actions";
import { saveCreditMemo, saveRefund, saveSalesReceipt } from "./sales-actions";

export type SalesDocFormKind = "invoice" | "sales_receipt" | "credit_memo" | "refund";
export type TaxRateChoice = { id: string; name: string; ratePercent: string };

type Line = {
  key: string;
  itemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxable: boolean;
};

const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5";
const METHODS = [
  ["cash", "Cash"],
  ["check", "Check"],
  ["credit_card", "Credit card"],
  ["ach", "ACH"],
  ["wire", "Wire"],
  ["other", "Other"],
] as const;

const COPY: Record<SalesDocFormKind, { date: string; party: string; post: string; route: string }> = {
  invoice: { date: "Invoice date", party: "Customer", post: "Posting finalizes the invoice: Dr Accounts Receivable, Cr income and sales tax.", route: "/ar/invoices" },
  sales_receipt: { date: "Sale date", party: "Customer (optional)", post: "Posting records the sale: Dr the deposit account, Cr income and sales tax.", route: "/ar/sales-receipts" },
  credit_memo: { date: "Credit date", party: "Customer", post: "Posting gives the credit: Dr income and sales tax, Cr Accounts Receivable.", route: "/ar/credit-memos" },
  refund: { date: "Refund date", party: "Customer", post: "Posting pays the refund: Dr income and sales tax, Cr the bank account.", route: "/ar/refunds" },
};

function blankLine(): Line {
  return { key: crypto.randomUUID(), itemId: "", description: "", quantity: "1", unitPrice: "", accountId: "", taxable: false };
}

/** Same rounding the server applies: qty × price, half-up to cents. */
function lineAmount(l: Line): Decimal {
  try {
    return money(l.quantity || "0").times(money(l.unitPrice || "0")).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } catch {
    return money(0);
  }
}

/**
 * One form for every sales document: invoices, sales receipts, credit
 * memos, and item refunds. Lines, the taxable flag, and the sales tax math
 * (rate × taxable total, rounded once) match the server's.
 */
export function SalesDocForm({
  kind,
  customers,
  items,
  incomeAccounts,
  taxRates,
  depositAccounts = [],
  bankAccounts = [],
  initial,
  initialLines,
  defaultCustomerId,
}: {
  kind: SalesDocFormKind;
  customers: Customer[];
  items: Item[];
  incomeAccounts: Account[];
  taxRates: TaxRateChoice[];
  depositAccounts?: Account[];
  bankAccounts?: Account[];
  initial?: ArInvoice;
  initialLines?: ArInvoiceLine[];
  defaultCustomerId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const today = format(new Date(), "yyyy-MM-dd");
  const copy = COPY[kind];
  const startCustomer = customers.find((c) => c.id === (initial?.customerId ?? defaultCustomerId));

  const [customerId, setCustomerId] = useState(startCustomer?.id ?? "");
  const [docDate, setDocDate] = useState(initial?.invoiceDate ?? today);
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [poNumber, setPoNumber] = useState(initial?.poNumber ?? "");
  const [method, setMethod] = useState(kind === "refund" ? "check" : "cash");
  const [reference, setReference] = useState("");
  const [depositAccountId, setDepositAccountId] = useState(
    depositAccounts.find((a) => a.code === "1250")?.id ?? depositAccounts[0]?.id ?? ""
  );
  const [bankAccountId, setBankAccountId] = useState(bankAccounts.find((a) => a.code === "1010")?.id ?? bankAccounts[0]?.id ?? "");
  const [taxCodeId, setTaxCodeId] = useState(initial ? (initial.taxCodeId ?? "") : (startCustomer?.defaultTaxCodeId ?? ""));
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
          taxable: l.taxable,
        }))
      : [blankLine()]
  );

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const customer = customers.find((c) => c.id === customerId);
  const currency = customer?.currency ?? "USD";
  const subtotal = sumMoney(lines.map(lineAmount));
  const taxable = sumMoney(lines.filter((l) => l.taxable).map(lineAmount));
  const rate = taxRates.find((r) => r.id === taxCodeId);
  const exempt = Boolean(customer?.taxExempt);
  const tax =
    rate && !exempt && taxable.gt(0)
      ? taxable.times(money(rate.ratePercent)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : money(0);
  const total = subtotal.plus(tax);
  const suggestedDue =
    customer && docDate ? format(addDays(parseISO(docDate), customer.defaultPaymentTermsDays), "yyyy-MM-dd") : "";

  function pickCustomer(id: string) {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (c?.defaultTaxCodeId) setTaxCodeId(c.defaultTaxCodeId);
  }

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
      taxable: item?.taxable ?? false,
    });
  }

  function submit(post: boolean) {
    setErr(null);
    start(async () => {
      const lineInput = lines
        .filter((l) => l.itemId || l.accountId)
        .map((l) => ({
          itemId: l.itemId || undefined,
          accountId: l.accountId || undefined,
          description: l.description,
          quantity: l.quantity || "1",
          unitPrice: l.unitPrice || undefined,
          taxable: l.taxable,
        }));
      const common = { taxCodeId: taxCodeId || null, memo, privateNote, lines: lineInput };
      const r =
        kind === "invoice"
          ? await saveInvoice(initial?.id ?? null, { customerId, invoiceDate: docDate, dueDate: dueDate || undefined, poNumber, ...common }, post)
          : kind === "sales_receipt"
            ? await saveSalesReceipt(
                { customerId: customerId || undefined, receiptDate: docDate, method: method as "cash", reference: reference || undefined, depositAccountId, ...common },
                post
              )
            : kind === "credit_memo"
              ? await saveCreditMemo({ customerId, memoDate: docDate, ...common }, post)
              : await saveRefund(
                  { kind: "items", customerId, refundDate: docDate, method: method as "check", reference: reference || undefined, bankAccountId, ...common },
                  post
                );
      if (r.ok) router.push(`${copy.route}/${r.id}`);
      else setErr(r.error);
    });
  }

  const needsCustomer = kind !== "sales_receipt";
  const canSave = !pending && (!needsCustomer || customerId) && docDate && subtotal.gt(0);

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{copy.party}</Label>
          <select value={customerId} onChange={(e) => pickCustomer(e.target.value)} className={`${cell} text-sm py-2`}>
            <option value="">{needsCustomer ? "Choose customer…" : "No customer"}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {customer?.email && <p className="text-[11px] text-muted-foreground mt-1">{customer.email}</p>}
          {exempt && (
            <p className="text-[11px] text-primary mt-1">Tax exempt{customer?.taxExemptReason ? `: ${customer.taxExemptReason}` : ""}</p>
          )}
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{copy.date}</Label>
          <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
        </div>
        {kind === "invoice" && (
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Due date</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            {!dueDate && suggestedDue && (
              <p className="text-[11px] text-muted-foreground mt-1">Net {customer?.defaultPaymentTermsDays}: {suggestedDue}</p>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        {kind === "invoice" && (
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Customer PO #</Label>
            <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
          </div>
        )}
        {(kind === "sales_receipt" || kind === "refund") && (
          <>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Payment method</Label>
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${cell} text-sm py-2`}>
                {METHODS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{kind === "refund" ? "Check #" : "Reference"}</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{kind === "refund" ? "Refund from" : "Deposit to"}</Label>
              {kind === "refund" ? (
                <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className={`${cell} text-sm py-2`}>
                  {bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              ) : (
                <select value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)} className={`${cell} text-sm py-2`}>
                  {depositAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              )}
            </div>
          </>
        )}
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Sales tax rate</Label>
          <select value={taxCodeId} onChange={(e) => setTaxCodeId(e.target.value)} className={`${cell} text-sm py-2`} aria-label="Sales tax rate">
            <option value="">No sales tax</option>
            {taxRates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({money(r.ratePercent).toString()}%)
              </option>
            ))}
          </select>
        </div>
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
              <th className="text-center font-medium px-3 py-2 w-12">Tax</th>
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
                    <option value="">None</option>
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
                <td className="px-3 py-2 text-right font-mono text-xs pt-3.5">{formatMoney(lineAmount(l), { currency })}</td>
                <td className="px-3 py-2 text-center pt-3">
                  <input
                    type="checkbox"
                    aria-label={`Line ${idx + 1} taxable`}
                    checked={l.taxable}
                    onChange={(e) => update(l.key, { taxable: e.target.checked })}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                </td>
                <td className="px-3 py-2">
                  <select value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })} className={cell}>
                    <option value="">{l.itemId ? "(from item)" : "Choose…"}</option>
                    {incomeAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
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
          <tfoot className="bg-muted/30">
            <tr className="border-t-2 border-border">
              <td colSpan={5} className="px-3 pt-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Subtotal</td>
              <td className="px-3 pt-2 text-right font-mono text-xs">{formatMoney(subtotal, { currency })}</td>
              <td colSpan={3}></td>
            </tr>
            <tr>
              <td colSpan={5} className="px-3 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                {rate ? `${rate.name} on ${formatMoney(exempt ? 0 : taxable, { currency })}${exempt ? " (exempt)" : ""}` : "Sales tax"}
              </td>
              <td className="px-3 py-1 text-right font-mono text-xs">{formatMoney(tax, { currency })}</td>
              <td colSpan={3}></td>
            </tr>
            <tr>
              <td colSpan={5} className="px-3 pb-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
              <td className="px-3 pb-2 text-right font-mono text-sm font-semibold">{formatMoney(total, { currency })}</td>
              <td colSpan={3}></td>
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
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Message to the customer</Label>
          <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} placeholder={kind === "invoice" ? "Thank you for your business." : ""} />
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
        <p className="text-[11px] text-muted-foreground">{copy.post}</p>
      </div>
    </div>
  );
}
