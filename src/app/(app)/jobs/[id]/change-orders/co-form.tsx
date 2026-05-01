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
import { upsertChangeOrder } from "./actions";

type CostCodeOption = { id: string; code: string; name: string };

type LineRow = {
  costCodeId: string;
  amount: string;
  description: string;
};

export function ChangeOrderForm({
  jobId,
  changeOrderId,
  costCodes,
  initial,
}: {
  jobId: string;
  changeOrderId?: string;
  costCodes: CostCodeOption[];
  initial?: {
    description: string;
    externalReference: string | null;
    contractAdjustment: string;
    scheduleAdjustmentDays: number;
    effectiveDate: string | null;
    notes: string | null;
    lines: Array<{
      costCodeId: string;
      amount: string;
      description: string | null;
    }>;
  };
}) {
  const router = useRouter();
  const isEdit = !!changeOrderId;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [description, setDescription] = useState(initial?.description ?? "");
  const [externalReference, setExternalReference] = useState(
    initial?.externalReference ?? ""
  );
  const [contractAdjustment, setContractAdjustment] = useState(
    initial?.contractAdjustment ?? ""
  );
  const [scheduleAdjustmentDays, setScheduleAdjustmentDays] = useState(
    String(initial?.scheduleAdjustmentDays ?? 0)
  );
  const [effectiveDate, setEffectiveDate] = useState(
    initial?.effectiveDate ?? ""
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const [lines, setLines] = useState<LineRow[]>(
    initial?.lines.map((l) => ({
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
      { costCodeId: "", amount: "", description: "" },
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
    if (!description.trim()) {
      setErr("Description is required.");
      return;
    }
    // Lines optional on draft, but we surface an obvious warning
    const cleanLines = lines
      .map((l) => ({
        costCodeId: l.costCodeId,
        amount: l.amount.trim(),
        description: l.description,
      }))
      .filter((l) => l.costCodeId && l.amount);

    start(async () => {
      const r = await upsertChangeOrder({
        changeOrderId,
        header: {
          jobId,
          description: description.trim(),
          externalReference,
          contractAdjustment: contractAdjustment.trim() || "0",
          scheduleAdjustmentDays: Number(scheduleAdjustmentDays || 0),
          effectiveDate,
          notes,
        },
        lines: cleanLines,
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      router.push(`/jobs/${jobId}/change-orders/${r.id}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold">
          Header
        </div>

        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Description
          </Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Owner-requested addition: extra elevator pit"
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
              placeholder="CCD-001"
              className="font-mono"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Contract adjustment
            </Label>
            <Input
              inputMode="decimal"
              value={contractAdjustment}
              onChange={(e) => setContractAdjustment(e.target.value)}
              placeholder="0.00"
              className="font-mono text-right"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Schedule Δ (days)
            </Label>
            <Input
              type="number"
              value={scheduleAdjustmentDays}
              onChange={(e) => setScheduleAdjustmentDays(e.target.value)}
              className="font-mono text-right"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Effective date
            </Label>
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
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
            Cost-code budget impact
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
                <th className="text-left font-medium px-3 py-2 w-1/3">
                  Cost code
                </th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-36">
                  Amount Δ
                </th>
                <th className="px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    No budget lines yet. Add at least one before submitting.
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
                        <SelectValue placeholder="— choose —" />
                      </SelectTrigger>
                      <SelectContent>
                        {costCodes.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            <span className="font-mono">{c.code}</span> —{" "}
                            {c.name}
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
                      placeholder="Optional note"
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
                  colSpan={2}
                  className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  Lines total
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                  {formatMoney(linesTotal.toFixed(4))}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Lines and contract adjustment can differ — the contract is what the
          owner will pay; lines are how the cost is budgeted internally.
        </p>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button
          onClick={submit}
          disabled={pending || !description.trim()}
        >
          {pending ? "Saving…" : isEdit ? "Save draft" : "Create draft"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => router.push(`/jobs/${jobId}/change-orders`)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
