"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import type {
  Account,
  ApBill,
  ApBillLine,
  CostCode,
  Job,
  Vendor,
} from "@/lib/db/schema";
import { formatMoney, money, sumMoney } from "@/lib/money";
import {
  createBill,
  updateBill,
  previewApprovalRouting,
  type BillInput,
} from "./actions";

type Line = {
  id: string;
  accountId: string;
  amount: string;
  description: string;
  jobId: string;
  costCodeId: string;
};

const EMPTY: Line = {
  id: "",
  accountId: "",
  amount: "",
  description: "",
  jobId: "",
  costCodeId: "",
};

function newLine(): Line {
  return { ...EMPTY, id: crypto.randomUUID() };
}

export function BillForm({
  vendors,
  accounts,
  jobs,
  costCodes,
  initial,
  initialLines,
}: {
  vendors: Vendor[];
  accounts: Account[];
  jobs: Job[];
  costCodes: CostCode[];
  initial?: ApBill;
  initialLines?: ApBillLine[];
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [routingPreview, setRoutingPreview] = useState<
    | { requiredRole: string; tierName: string | null; fallback: boolean }
    | null
  >(null);

  const today = new Date().toISOString().slice(0, 10);
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? "");
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState(
    initial?.vendorInvoiceNumber ?? ""
  );
  const [billDate, setBillDate] = useState(initial?.billDate ?? today);
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? today);
  const [discountDate, setDiscountDate] = useState(
    initial?.discountDate ?? ""
  );
  const [currency] = useState(initial?.currency ?? "USD");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<Line[]>(
    initialLines && initialLines.length > 0
      ? initialLines.map((l) => ({
          id: crypto.randomUUID(),
          accountId: l.accountId,
          amount: l.amount,
          description: l.description ?? "",
          jobId: l.jobId ?? "",
          costCodeId: l.costCodeId ?? "",
        }))
      : [newLine()]
  );

  const subtotal = useMemo(
    () => sumMoney(lines.map((l) => l.amount || "0")),
    [lines]
  );

  const postingAccounts = accounts.filter(
    (a) =>
      a.accountType === "posting" &&
      a.isActive &&
      !a.isBlocked &&
      a.directPosting // exclude AP control
  );

  function updateLine(id: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, newLine()]);
  }
  function removeLine(id: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));
  }

  async function previewRouting() {
    const r = await previewApprovalRouting(subtotal.toFixed(2));
    setRoutingPreview(r);
  }

  function submit() {
    setErr(null);
    start(async () => {
      const payload: BillInput = {
        vendorId,
        vendorInvoiceNumber,
        billDate,
        dueDate,
        discountDate,
        currency: currency.toUpperCase(),
        exchangeRate: "1",
        discountPercent: "0",
        description,
        notes,
        lines: lines
          .filter((l) => l.accountId && l.amount)
          .map((l) => ({
            accountId: l.accountId,
            amount: l.amount,
            description: l.description,
            jobId: l.jobId || null,
            costCodeId: l.costCodeId || null,
          })),
      };
      const r = isEdit
        ? await updateBill(initial!.id, payload)
        : await createBill(payload);
      if (r.ok) router.push(`/ap/bills/${r.id}`);
      else setErr(r.error);
    });
  }

  const canSave =
    !pending &&
    vendorId &&
    billDate &&
    dueDate &&
    lines.some((l) => l.accountId && money(l.amount || "0").gt(0));

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Vendor
          </Label>
          <Select value={vendorId} onValueChange={(v) => setVendorId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="— choose vendor —" />
            </SelectTrigger>
            <SelectContent>
              {vendors.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.code} — {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Vendor invoice #
          </Label>
          <Input
            value={vendorInvoiceNumber}
            onChange={(e) => setVendorInvoiceNumber(e.target.value)}
            placeholder="INV-12345"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Bill date
          </Label>
          <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Due date
          </Label>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Discount date (optional)
          </Label>
          <Input
            type="date"
            value={discountDate}
            onChange={(e) => setDiscountDate(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Description
        </Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-8"></th>
              <th className="text-left font-medium px-3 py-2">Account</th>
              <th className="text-left font-medium px-3 py-2 w-40">Job</th>
              <th className="text-left font-medium px-3 py-2 w-40">Cost code</th>
              <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-left font-medium px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                  {idx + 1}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={l.accountId}
                    onChange={(e) => updateLine(l.id, { accountId: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  >
                    <option value="">— choose account —</option>
                    {postingAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={l.jobId}
                    onChange={(e) => updateLine(l.id, { jobId: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  >
                    <option value="">—</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.code} — {j.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={l.costCodeId}
                    onChange={(e) => updateLine(l.id, { costCodeId: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  >
                    <option value="">—</option>
                    {costCodes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} — {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={l.amount}
                    onChange={(e) => updateLine(l.id, { amount: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-right font-mono"
                    placeholder="0.00"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={l.description}
                    onChange={(e) => updateLine(l.id, { description: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => removeLine(l.id)}
                    disabled={lines.length <= 1}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30 border-t-2 border-border">
              <td></td>
              <td
                className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                colSpan={3}
              >
                Subtotal
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                {formatMoney(subtotal, { currency })}
              </td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={addLine}>
          <Plus className="h-3.5 w-3.5" />
          Add line
        </Button>
        <Button variant="ghost" size="sm" onClick={previewRouting}>
          Preview approval routing
        </Button>
        {routingPreview && (
          <span className="text-[11px] text-muted-foreground">
            Tier:{" "}
            <span className="text-foreground">
              {routingPreview.tierName ?? "(no match — fallback)"}
            </span>
            {" · "}
            Required:{" "}
            <span className="text-primary font-semibold">
              {routingPreview.requiredRole}
            </span>
          </span>
        )}
      </div>

      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Notes
        </Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button onClick={submit} disabled={!canSave}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Save draft"}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/ap/bills")}>
          Cancel
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Saves as <strong>draft</strong>. Submit for approval from the bill detail
          page.
        </p>
      </div>
    </div>
  );
}
