"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
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
import { formatMoney, money } from "@/lib/money";
import { upsertCommitment } from "./actions";

type JobOption = { id: string; code: string; name: string };
type VendorOption = { id: string; code: string; name: string };
type CostCodeOption = { id: string; code: string; name: string };
type AccountOption = { id: string; code: string; name: string };

type LineRow = {
  accountId: string;
  costCodeId: string;
  amount: string;
  description: string;
};

export function CommitmentForm({
  commitmentId,
  presetJobId,
  jobs,
  vendors,
  accounts,
  costCodes,
  initial,
}: {
  commitmentId?: string;
  /** When the form opens from /jobs/[id]/commitments/new, lock the job. */
  presetJobId?: string;
  jobs: JobOption[];
  vendors: VendorOption[];
  accounts: AccountOption[];
  costCodes: CostCodeOption[];
  initial?: {
    jobId: string;
    vendorId: string;
    type: "po" | "subcontract";
    description: string;
    externalReference: string | null;
    currency: string;
    exchangeRate: string;
    effectiveDate: string | null;
    expirationDate: string | null;
    notes: string | null;
    lines: Array<{
      accountId: string;
      costCodeId: string;
      amount: string;
      description: string | null;
    }>;
  };
}) {
  const router = useRouter();
  const isEdit = !!commitmentId;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [jobId, setJobId] = useState(initial?.jobId ?? presetJobId ?? "");
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? "");
  const [type, setType] = useState<"po" | "subcontract">(initial?.type ?? "po");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [externalReference, setExternalReference] = useState(
    initial?.externalReference ?? ""
  );
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [effectiveDate, setEffectiveDate] = useState(
    initial?.effectiveDate ?? ""
  );
  const [expirationDate, setExpirationDate] = useState(
    initial?.expirationDate ?? ""
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const [lines, setLines] = useState<LineRow[]>(
    initial?.lines.map((l) => ({
      accountId: l.accountId,
      costCodeId: l.costCodeId,
      amount: l.amount,
      description: l.description ?? "",
    })) ?? []
  );

  const linesTotal = lines.reduce(
    (acc, l) => acc.plus(money(l.amount || "0")),
    money(0)
  );

  function addLine() {
    setLines((prev) => [
      ...prev,
      { accountId: "", costCodeId: "", amount: "", description: "" },
    ]);
  }
  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, ...patch } : l))
    );
  }
  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function submit() {
    setErr(null);
    if (!description.trim() || !jobId || !vendorId) {
      setErr("Job, vendor, and description are required.");
      return;
    }
    const cleanLines = lines
      .map((l) => ({
        accountId: l.accountId,
        costCodeId: l.costCodeId,
        amount: l.amount.trim(),
        description: l.description,
      }))
      .filter((l) => l.accountId && l.costCodeId && l.amount);

    start(async () => {
      const r = await upsertCommitment({
        commitmentId,
        header: {
          jobId,
          vendorId,
          type,
          description: description.trim(),
          externalReference,
          currency,
          exchangeRate: "",
          effectiveDate,
          expirationDate,
          notes,
        },
        lines: cleanLines,
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      router.push(`/commitments/${r.id}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold">
          Header
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Type
            </Label>
            <Select
              value={type}
              onValueChange={(v) =>
                setType(v === "subcontract" ? "subcontract" : "po")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="po">Purchase Order (PO-)</SelectItem>
                <SelectItem value="subcontract">Subcontract (SUB-)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Job
            </Label>
            <Select
              value={jobId || undefined}
              onValueChange={(v) => setJobId(v ?? "")}
              disabled={!!presetJobId || isEdit}
            >
              <SelectTrigger>
                <SelectValue placeholder="— choose job —" />
              </SelectTrigger>
              <SelectContent>
                {jobs.map((j) => (
                  <SelectItem key={j.id} value={j.id}>
                    <span className="font-mono">{j.code}</span> {j.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Vendor
            </Label>
            <Select
              value={vendorId || undefined}
              onValueChange={(v) => setVendorId(v ?? "")}
            >
              <SelectTrigger>
                <SelectValue placeholder="— choose vendor —" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    <span className="font-mono">{v.code}</span> {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Description
          </Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Concrete supply for foundation pours"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              External reference
            </Label>
            <Input
              value={externalReference}
              onChange={(e) => setExternalReference(e.target.value)}
              placeholder="Vendor PO# or contract #"
              className="font-mono"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Effective
            </Label>
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Expiration
            </Label>
            <Input
              type="date"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Currency
            </Label>
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              className="font-mono w-24"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Notes
            </Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold">
            Lines
          </div>
          <Button size="sm" variant="ghost" onClick={addLine} disabled={pending}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add line
          </Button>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-1/4">
                  Cost code
                </th>
                <th className="text-left font-medium px-3 py-2 w-1/4">
                  Account
                </th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-32">
                  Amount
                </th>
                <th className="px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    No lines yet — add at least one before issuing.
                  </td>
                </tr>
              )}
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Select
                      value={l.costCodeId || undefined}
                      onValueChange={(v) =>
                        updateLine(i, { costCodeId: v ?? "" })
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {costCodes.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            <span className="font-mono">{c.code}</span> {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      value={l.accountId || undefined}
                      onValueChange={(v) =>
                        updateLine(i, { accountId: v ?? "" })
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            <span className="font-mono">{a.code}</span> {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      value={l.description}
                      onChange={(e) =>
                        updateLine(i, { description: e.target.value })
                      }
                      placeholder="Optional"
                      className="h-8 text-xs"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      inputMode="decimal"
                      value={l.amount}
                      onChange={(e) =>
                        updateLine(i, { amount: e.target.value })
                      }
                      placeholder="0.00"
                      className="h-8 text-xs font-mono text-right"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => removeLine(i)}
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/30 border-t-2 border-border">
                <td
                  colSpan={3}
                  className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  Total
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                  {formatMoney(linesTotal.toFixed(4), { currency })}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save draft" : "Create draft"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => router.back()}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
