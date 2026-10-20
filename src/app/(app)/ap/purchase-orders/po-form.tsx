"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Account, CompanyAddress, Item, PurchaseOrder, PurchaseOrderLine, Vendor } from "@/lib/db/schema";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { savePurchaseOrder } from "./actions";

type Line = { key: string; itemId: string; accountId: string; description: string; quantity: string; unitCost: string };

const blank = (): Line => ({ key: crypto.randomUUID(), itemId: "", accountId: "", description: "", quantity: "1", unitCost: "" });
const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";
const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5";
const ADDRESS_FIELDS = [
  ["street1", "Street"],
  ["street2", "Street 2"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP"],
  ["country", "Country"],
] as const;

function lineTotal(l: Line) {
  try {
    return money(l.quantity || "0").times(money(l.unitCost || "0")).toDecimalPlaces(2);
  } catch {
    return money(0);
  }
}

export function PurchaseOrderForm({
  vendors,
  items,
  accounts,
  companyAddress,
  initial,
  initialLines,
  defaultVendorId,
}: {
  vendors: Vendor[];
  items: Item[];
  accounts: Account[];
  companyAddress: CompanyAddress;
  initial?: PurchaseOrder;
  initialLines?: PurchaseOrderLine[];
  defaultVendorId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? defaultVendorId ?? "");
  const [poDate, setPoDate] = useState(initial?.poDate ?? format(new Date(), "yyyy-MM-dd"));
  const [expectedDate, setExpectedDate] = useState(initial?.expectedDate ?? "");
  const [shipTo, setShipTo] = useState<CompanyAddress>(initial?.shipTo ?? companyAddress);
  const [vendorMessage, setVendorMessage] = useState(initial?.vendorMessage ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [lines, setLines] = useState<Line[]>(
    initialLines?.length
      ? initialLines.map((l) => ({
          key: l.id,
          itemId: l.itemId ?? "",
          accountId: l.accountId,
          description: l.description ?? "",
          quantity: money(l.quantity).toString(),
          unitCost: money(l.unitCost).toString(),
        }))
      : [blank()]
  );
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const total = sumMoney(lines.map(lineTotal));

  function update(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: string, itemId: string) {
    const item = itemById.get(itemId);
    update(key, {
      itemId,
      ...(item
        ? {
            accountId: item.expenseAccountId ?? "",
            description: item.description ?? item.name,
            unitCost: item.purchaseCost ? money(item.purchaseCost).toString() : "",
          }
        : {}),
    });
  }

  function submit(andSubmit: boolean) {
    setErr(null);
    start(async () => {
      const r = await savePurchaseOrder(
        initial?.id ?? null,
        {
          vendorId,
          poDate,
          expectedDate: expectedDate || null,
          shipTo: Object.fromEntries(ADDRESS_FIELDS.map(([k]) => [k, shipTo[k] ?? ""])),
          vendorMessage,
          memo,
          lines: lines
            .filter((l) => l.accountId || l.itemId)
            .map((l) => ({
              itemId: l.itemId || undefined,
              accountId: l.accountId || undefined,
              description: l.description,
              quantity: l.quantity || "1",
              unitCost: l.unitCost || undefined,
            })),
        },
        andSubmit
      );
      if (r.ok) router.push(`/ap/purchase-orders/${r.id}`);
      else setErr(r.error);
    });
  }

  const canSave = !pending && vendorId && poDate && total.gt(0);

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <Label className={label}>Vendor</Label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={`${cell} text-sm py-2`} aria-label="Vendor">
            <option value="">Choose vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className={label}>PO date</Label>
          <Input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} aria-label="PO date" />
        </div>
        <div>
          <Label className={label}>Expected</Label>
          <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} aria-label="Expected date" />
        </div>
      </div>

      <div>
        <div className={label}>Ship to</div>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
          {ADDRESS_FIELDS.map(([k, name]) => (
            <Input
              key={k}
              className={k === "street1" || k === "street2" ? "col-span-2 sm:col-span-3" : "sm:col-span-2"}
              value={shipTo[k] ?? ""}
              onChange={(e) => setShipTo((a) => ({ ...a, [k]: e.target.value }))}
              placeholder={name}
              aria-label={`Ship to ${name.toLowerCase()}`}
            />
          ))}
        </div>
      </div>

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-8">#</th>
              <th className="text-left font-medium px-3 py-2 w-44">Product / service</th>
              <th className="text-left font-medium px-3 py-2 w-52">Account</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
              <th className="text-right font-medium px-3 py-2 w-28">Unit cost</th>
              <th className="text-right font-medium px-3 py-2 w-28">Amount</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="border-t border-border">
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{i + 1}</td>
                <td className="px-3 py-2">
                  <select value={l.itemId} onChange={(e) => pickItem(l.key, e.target.value)} className={cell} aria-label={`Line ${i + 1} item`}>
                    <option value="">None</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>{it.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select value={l.accountId} onChange={(e) => update(l.key, { accountId: e.target.value })} className={cell} aria-label={`Line ${i + 1} account`}>
                    <option value="">Choose…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} className={cell} aria-label={`Line ${i + 1} description`} />
                </td>
                <td className="px-3 py-2">
                  <input
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => update(l.key, { quantity: e.target.value })}
                    className={`${cell} text-right font-mono`}
                    aria-label={`Line ${i + 1} quantity`}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    inputMode="decimal"
                    value={l.unitCost}
                    onChange={(e) => update(l.key, { unitCost: e.target.value })}
                    className={`${cell} text-right font-mono`}
                    placeholder="0.00"
                    aria-label={`Line ${i + 1} unit cost`}
                  />
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(lineTotal(l))}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setLines((p) => (p.length > 1 ? p.filter((x) => x.key !== l.key) : p))}
                    disabled={lines.length <= 1}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30"
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
              <td colSpan={6} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
              <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{formatMoney(total)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, blank()])}>
        <Plus className="h-3.5 w-3.5" /> Add line
      </Button>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className={label}>Message to vendor</Label>
          <Textarea value={vendorMessage} onChange={(e) => setVendorMessage(e.target.value)} rows={2} placeholder="Printed on the PO" />
        </div>
        <div>
          <Label className={label}>Memo</Label>
          <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} placeholder="Internal; not printed" />
        </div>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
        <Button onClick={() => submit(true)} disabled={!canSave}>
          {pending ? "Saving…" : "Save and submit"}
        </Button>
        <Button variant="outline" onClick={() => submit(false)} disabled={!canSave}>
          Save draft
        </Button>
        <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <p className="text-[11px] text-muted-foreground">Submitting approves it at once if your role meets the bill approval threshold.</p>
      </div>
    </div>
  );
}
