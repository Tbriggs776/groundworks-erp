"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money";
import type { JobCostRow } from "@/lib/projects/job-cost";
import {
  addJobCostCode,
  removeJobCostCode,
  updateJobCostCode,
} from "./actions";

type CostCodeOption = {
  id: string;
  code: string;
  name: string;
  costType: string;
};

export function BudgetEditor({
  jobId,
  jobIsClosed,
  rows,
  totalBudget,
  totalActual,
  totalCommitted,
  totalOpenBudget,
  allCostCodes,
}: {
  jobId: string;
  jobIsClosed: boolean;
  rows: JobCostRow[];
  totalBudget: string;
  totalActual: string;
  totalCommitted: string;
  totalOpenBudget: string;
  allCostCodes: CostCodeOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // Inline-edit state per row id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftAmount, setDraftAmount] = useState("");
  const [draftNotes, setDraftNotes] = useState("");

  // Add-row state
  const [newCostCodeId, setNewCostCodeId] = useState<string>("");
  const [newAmount, setNewAmount] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const usedCostCodeIds = useMemo(
    () => new Set(rows.filter((r) => !r.unbudgeted).map((r) => r.costCodeId)),
    [rows]
  );

  const availableCostCodes = useMemo(
    () => allCostCodes.filter((c) => !usedCostCodeIds.has(c.id)),
    [allCostCodes, usedCostCodeIds]
  );

  function startEdit(r: JobCostRow) {
    if (jobIsClosed || !r.jobCostCodeId) return;
    setEditingId(r.jobCostCodeId);
    setDraftAmount(stripTrailingZeros(r.budget));
    setDraftNotes("");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftAmount("");
    setDraftNotes("");
    setErr(null);
  }

  function saveEdit(jobCostCodeId: string) {
    setErr(null);
    start(async () => {
      const r = await updateJobCostCode({
        jobCostCodeId,
        budgetAmount: draftAmount.trim() || "0",
        notes: draftNotes,
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      cancelEdit();
      router.refresh();
    });
  }

  function remove(r: JobCostRow) {
    if (!r.jobCostCodeId) return;
    if (
      !confirm(
        `Remove ${r.costCode} ${r.costCodeName} from this job's budget?`
      )
    )
      return;
    setErr(null);
    start(async () => {
      const result = await removeJobCostCode({ jobCostCodeId: r.jobCostCodeId! });
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      router.refresh();
    });
  }

  function addRow() {
    setErr(null);
    if (!newCostCodeId || !newAmount.trim()) {
      setErr("Pick a cost code and enter a budget amount.");
      return;
    }
    start(async () => {
      const r = await addJobCostCode({
        jobId,
        costCodeId: newCostCodeId,
        budgetAmount: newAmount.trim(),
        notes: newNotes,
      });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setNewCostCodeId("");
      setNewAmount("");
      setNewNotes("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {/* Roll-up tiles */}
      <div className="grid grid-cols-4 gap-3">
        <Tile label="Total budget" value={totalBudget} />
        <Tile label="Committed" value={totalCommitted} muted />
        <Tile label="Actual to date" value={totalActual} accent />
        <Tile
          label="Open budget"
          value={totalOpenBudget}
          warn={Number(totalOpenBudget) < 0}
        />
      </div>

      {jobIsClosed && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          This job is <span className="font-semibold">closed</span> — budget is
          read-only.
        </div>
      )}

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-32">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-24">Type</th>
              <th className="text-right font-medium px-3 py-2 w-32">Budget</th>
              <th className="text-right font-medium px-3 py-2 w-32">Committed</th>
              <th className="text-right font-medium px-3 py-2 w-32">Actual</th>
              <th className="text-right font-medium px-3 py-2 w-32">Variance</th>
              <th className="text-right font-medium px-3 py-2 w-20">% Used</th>
              <th className="px-3 py-2 w-32"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className="border-t border-border">
                <td
                  colSpan={9}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No cost codes budgeted yet. Add one below to start tracking.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const isEditing = editingId === r.jobCostCodeId;
              const variance = Number(r.variance);
              return (
                <tr
                  key={`${r.jobCostCodeId ?? "u"}-${r.costCodeId}`}
                  className={`border-t border-border ${
                    r.unbudgeted ? "bg-amber-500/5" : ""
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.costCode}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.costCodeName}
                    {r.unbudgeted && (
                      <Badge
                        variant="secondary"
                        className="ml-2 text-[8px] uppercase tracking-wider"
                      >
                        unbudgeted
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {r.costType}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {isEditing ? (
                      <Input
                        inputMode="decimal"
                        value={draftAmount}
                        onChange={(e) => setDraftAmount(e.target.value)}
                        className="h-7 text-right font-mono text-xs"
                        autoFocus
                      />
                    ) : (
                      formatMoney(r.budget)
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                    {formatMoney(r.committed)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(r.actual)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs ${
                      variance < 0 ? "text-destructive" : "text-foreground"
                    }`}
                  >
                    {formatMoney(r.variance)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                    {r.percentUsed === null ? "—" : `${r.percentUsed.toFixed(1)}%`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isEditing ? (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={cancelEdit}
                          disabled={pending}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => saveEdit(r.jobCostCodeId!)}
                          disabled={pending}
                        >
                          Save
                        </Button>
                      </div>
                    ) : (
                      !jobIsClosed &&
                      r.jobCostCodeId && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            className="text-[10px] text-muted-foreground hover:text-foreground uppercase tracking-wider"
                            onClick={() => startEdit(r)}
                          >
                            Edit
                          </button>
                          <span className="text-muted-foreground">·</span>
                          <button
                            className="text-[10px] text-muted-foreground hover:text-destructive uppercase tracking-wider"
                            onClick={() => remove(r)}
                          >
                            Remove
                          </button>
                        </div>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30 border-t-2 border-border">
              <td colSpan={3} className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Totals
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                {formatMoney(totalBudget)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                {formatMoney(totalCommitted)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                {formatMoney(totalActual)}
              </td>
              <td
                className={`px-3 py-2 text-right font-mono text-xs font-semibold ${
                  Number(totalBudget) - Number(totalActual) < 0
                    ? "text-destructive"
                    : ""
                }`}
              >
                {formatMoney(
                  (Number(totalBudget) - Number(totalActual)).toFixed(4)
                )}
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Add row */}
      {!jobIsClosed && (
        <div className="rounded-md border border-border p-4 bg-card space-y-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
            Add cost code to budget
          </div>
          <div className="grid grid-cols-[2fr_1fr_2fr_auto] gap-3 items-end">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Cost code
              </Label>
              <Select
                value={newCostCodeId || undefined}
                onValueChange={(v) => setNewCostCodeId(v ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— choose code —" />
                </SelectTrigger>
                <SelectContent>
                  {availableCostCodes.length === 0 && (
                    <div className="text-xs text-muted-foreground px-3 py-2">
                      All active cost codes are already on the budget.
                    </div>
                  )}
                  {availableCostCodes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="font-mono">{c.code}</span> — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Budget
              </Label>
              <Input
                inputMode="decimal"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                placeholder="0.00"
                className="font-mono text-right"
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Notes (optional)
              </Label>
              <Input
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="Estimator's note, scope clarification, etc."
              />
            </div>
            <Button
              disabled={pending || !newCostCodeId || !newAmount.trim()}
              onClick={addRow}
            >
              Add
            </Button>
          </div>
        </div>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

function Tile({
  label,
  value,
  muted,
  accent,
  warn,
}: {
  label: string;
  value: string;
  muted?: boolean;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
        {label}
      </div>
      <div
        className={`font-mono text-lg ${
          warn
            ? "text-destructive"
            : accent
              ? "text-primary"
              : muted
                ? "text-muted-foreground"
                : "text-foreground"
        }`}
      >
        {formatMoney(value)}
      </div>
    </div>
  );
}

function stripTrailingZeros(numericStr: string): string {
  // The DB returns "1234.5000" — trim trailing zeros for the editable input
  // so you don't fight the form when bumping a budget.
  if (!numericStr.includes(".")) return numericStr;
  return numericStr.replace(/0+$/, "").replace(/\.$/, "");
}
