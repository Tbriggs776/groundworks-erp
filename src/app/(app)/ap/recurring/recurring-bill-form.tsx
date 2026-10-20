"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Account, RecurringBill, RecurringBillLine, Vendor } from "@/lib/db/schema";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { saveRecurringBill } from "./actions";
import { BILL_TYPE_NOTE, FREQUENCY_LABEL } from "./labels";

type Line = { key: string; accountId: string; amount: string; description: string };

const blank = (): Line => ({ key: crypto.randomUUID(), accountId: "", amount: "", description: "" });
const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";
const cell = "w-full text-xs bg-background border border-border rounded-md px-2 py-1.5";
const TYPES = [
  ["scheduled", "Scheduled: create and submit each bill"],
  ["reminder", "Reminder: create a draft to review"],
  ["unscheduled", "Unscheduled: use it by hand"],
] as const;

function safe(v: string) {
  try {
    return money(v || "0");
  } catch {
    return money(0);
  }
}

export function RecurringBillForm({
  vendors,
  accounts,
  initial,
  initialLines,
}: {
  vendors: Vendor[];
  accounts: Account[];
  initial?: RecurringBill;
  initialLines?: RecurringBillLine[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<string>(initial?.type ?? "scheduled");
  const [frequency, setFrequency] = useState<string>(initial?.frequency ?? "monthly");
  const [daysInAdvance, setDaysInAdvance] = useState(String(initial?.daysInAdvance ?? 0));
  const [ends, setEnds] = useState<"never" | "date" | "count">(initial?.endDate ? "date" : initial?.maxOccurrences ? "count" : "never");
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [maxOccurrences, setMaxOccurrences] = useState(initial?.maxOccurrences ? String(initial.maxOccurrences) : "");
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? "");
  const [date, setDate] = useState(initial?.nextRunDate ?? format(new Date(), "yyyy-MM-dd"));
  const [description, setDescription] = useState(initial?.description ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<Line[]>(
    initialLines?.length
      ? initialLines.map((l) => ({ key: l.id, accountId: l.accountId, amount: money(l.amount).toFixed(2), description: l.description ?? "" }))
      : [blank()]
  );
  const unscheduled = type === "unscheduled";
  const total = sumMoney(lines.map((l) => safe(l.amount)));

  function update(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function save() {
    setErr(null);
    start(async () => {
      const r = await saveRecurringBill(initial?.id ?? null, {
        name,
        vendorId,
        type: type as "scheduled",
        frequency: frequency as "monthly",
        date: unscheduled ? undefined : date,
        endDate: !unscheduled && ends === "date" && endDate ? endDate : null,
        maxOccurrences: !unscheduled && ends === "count" && maxOccurrences ? Number(maxOccurrences) : null,
        daysInAdvance: Number(daysInAdvance) || 0,
        description,
        notes,
        lines: lines.filter((l) => l.accountId && l.amount).map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description })),
      });
      if (r.ok) router.push(`/ap/recurring/${r.id}`);
      else setErr(r.error);
    });
  }

  const canSave = !pending && name.trim() && vendorId && (unscheduled || date) && total.gt(0);

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="rounded-md border border-border p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="sm:col-span-2">
            <Label className={label}>Template name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Office rent" aria-label="Template name" />
          </div>
          <div className="sm:col-span-2">
            <Label className={label}>Type</Label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={`${cell} text-sm py-2`} aria-label="Type">
              {TYPES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1">{BILL_TYPE_NOTE[type]}</p>
          </div>
        </div>
        {!unscheduled && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <Label className={label}>Repeats</Label>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={`${cell} text-sm py-2`} aria-label="Repeats">
                {Object.entries(FREQUENCY_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className={label}>Create days in advance</Label>
              <Input type="number" min={0} max={90} value={daysInAdvance} onChange={(e) => setDaysInAdvance(e.target.value)} />
            </div>
            <div>
              <Label className={label}>Ends</Label>
              <select value={ends} onChange={(e) => setEnds(e.target.value as "never")} className={`${cell} text-sm py-2`} aria-label="Ends">
                <option value="never">Never</option>
                <option value="date">On a date</option>
                <option value="count">After a number of bills</option>
              </select>
            </div>
            <div>
              {ends === "date" && (
                <>
                  <Label className={label}>End date</Label>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </>
              )}
              {ends === "count" && (
                <>
                  <Label className={label}>Bills</Label>
                  <Input type="number" min={1} value={maxOccurrences} onChange={(e) => setMaxOccurrences(e.target.value)} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

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
        {!unscheduled && (
          <div>
            <Label className={label}>{initial ? "Next bill date" : "First bill date"}</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Bill date" />
          </div>
        )}
      </div>
      <div>
        <Label className={label}>Description</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Defaults to the template name" />
      </div>

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-8">#</th>
              <th className="text-left font-medium px-3 py-2">Account</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="border-t border-border">
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{i + 1}</td>
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
              <td colSpan={3} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Each bill</td>
              <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{formatMoney(total)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Button variant="ghost" size="sm" onClick={() => setLines((p) => [...p, blank()])}>
        <Plus className="h-3.5 w-3.5" /> Add line
      </Button>
      <div>
        <Label className={label}>Notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
        <Button onClick={save} disabled={!canSave}>
          {pending ? "Saving…" : "Save template"}
        </Button>
        <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
      </div>
    </div>
  );
}
