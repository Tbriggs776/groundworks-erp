"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Account, Vendor } from "@/lib/db/schema";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { saveVendorCredit } from "../ap-actions";

type Line = { key: string; accountId: string; description: string; amount: string };
const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5";
const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";
const blank = (): Line => ({ key: crypto.randomUUID(), accountId: "", description: "", amount: "" });

/** A vendor's credit memo: lines credit the accounts the original bills hit. */
export function VendorCreditForm({ vendors, accounts, defaultVendorId }: { vendors: Vendor[]; accounts: Account[]; defaultVendorId?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(defaultVendorId ?? "");
  const [creditDate, setCreditDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [vendorReference, setVendorReference] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([blank()]);
  const vendor = vendors.find((v) => v.id === vendorId);
  const currency = vendor?.currency ?? "USD";
  const total = sumMoney(lines.map((l) => {
    try {
      return money(l.amount || "0");
    } catch {
      return money(0);
    }
  }));
  const update = (key: string, patch: Partial<Line>) => setLines((p) => p.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function submit(post: boolean) {
    setErr(null);
    start(async () => {
      const r = await saveVendorCredit(
        {
          vendorId,
          creditDate,
          vendorReference,
          memo,
          lines: lines.filter((l) => l.accountId || l.amount).map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description })),
        },
        post
      );
      if (r.ok) router.push(`/ap/vendor-credits/${r.id}`);
      else setErr(r.error);
    });
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2">
          <Label className={label}>Vendor</Label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={`${cell} text-sm py-2`} aria-label="Vendor">
            <option value="">Choose vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className={label}>Credit date</Label>
          <Input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} />
        </div>
        <div>
          <Label className={label}>Vendor&apos;s credit #</Label>
          <Input value={vendorReference} onChange={(e) => setVendorReference(e.target.value)} placeholder="Optional" />
        </div>
      </div>

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-56">Account</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="border-t border-border">
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
                    value={l.amount}
                    onChange={(e) => update(l.key, { amount: e.target.value })}
                    className={`${cell} text-right font-mono`}
                    placeholder="0.00"
                    aria-label={`Line ${i + 1} amount`}
                  />
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
              <td colSpan={2} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Total credit</td>
              <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{formatMoney(total, { currency })}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, blank()])}>
        <Plus className="h-3.5 w-3.5" /> Add line
      </Button>
      <div>
        <Label className={label}>Memo</Label>
        <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} placeholder="What the credit is for" />
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
        <Button onClick={() => submit(true)} disabled={pending || !vendorId || !total.gt(0)}>
          {pending ? "Saving…" : "Save and post"}
        </Button>
        <Button variant="outline" onClick={() => submit(false)} disabled={pending || !vendorId || !total.gt(0)}>
          Save draft
        </Button>
        <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <p className="text-[11px] text-muted-foreground">Posting records it: Dr Accounts Payable, Cr each line&apos;s account.</p>
      </div>
    </div>
  );
}
