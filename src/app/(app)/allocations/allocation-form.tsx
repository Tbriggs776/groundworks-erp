"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import type { Account } from "@/lib/db/schema";
import {
  createAllocation,
  updateAllocation,
  type AllocationInput,
} from "./actions";

type Target = {
  id: string;
  accountId: string;
  percent: string;
  memo: string;
};

type Initial = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  allocationType: AllocationInput["allocationType"];
  sourceStatisticalAccountId?: string | null;
  isActive: boolean;
  targets: Array<{ accountId: string; percent: string; memo?: string | null }>;
};

function newTarget(): Target {
  return {
    id: crypto.randomUUID(),
    accountId: "",
    percent: "",
    memo: "",
  };
}

export function AllocationForm({
  accounts,
  initial,
}: {
  accounts: Account[];
  initial?: Initial;
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [allocationType, setAllocationType] = useState<
    AllocationInput["allocationType"]
  >(initial?.allocationType ?? "fixed");
  const [sourceStatId, setSourceStatId] = useState(
    initial?.sourceStatisticalAccountId ?? ""
  );
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [targets, setTargets] = useState<Target[]>(
    initial
      ? initial.targets.map((t) => ({
          id: crypto.randomUUID(),
          accountId: t.accountId,
          percent: t.percent,
          memo: t.memo ?? "",
        }))
      : [newTarget(), newTarget()]
  );

  const totalPercent = useMemo(
    () =>
      targets.reduce((acc, t) => {
        const n = Number(t.percent || 0);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0),
    [targets]
  );
  const percentOk = Math.abs(totalPercent - 100) < 0.0001;

  function updateTarget(id: string, patch: Partial<Target>) {
    setTargets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
    );
  }
  function addTarget() {
    setTargets((prev) => [...prev, newTarget()]);
  }
  function removeTarget(id: string) {
    setTargets((prev) => (prev.length > 2 ? prev.filter((t) => t.id !== id) : prev));
  }

  function submit() {
    setErr(null);
    start(async () => {
      const payload: AllocationInput = {
        code: code.trim(),
        name: name.trim(),
        description: description.trim(),
        allocationType,
        sourceStatisticalAccountId: sourceStatId || null,
        isActive,
        targets: targets
          .filter((t) => t.accountId)
          .map((t) => ({
            accountId: t.accountId,
            percent: t.percent || "0",
            memo: t.memo,
          })),
      };
      const r = isEdit
        ? await updateAllocation(initial!.id, payload)
        : await createAllocation(payload);
      if (r.ok) router.push("/allocations");
      else setErr(r.error);
    });
  }

  const postingAccounts = accounts.filter(
    (a) => a.accountType === "posting" && a.isActive && !a.isBlocked
  );
  const statisticalAccounts = accounts.filter((a) => a.isStatistical);

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Code
          </Label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="OVERHEAD-SPLIT"
            autoFocus={!isEdit}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Name
          </Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Overhead by department"
          />
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
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Allocation type
          </Label>
          <Select
            value={allocationType}
            onValueChange={(v) =>
              setAllocationType(
                (v ?? "fixed") as AllocationInput["allocationType"]
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">
                Fixed — static percentages
              </SelectItem>
              <SelectItem value="statistical" disabled>
                Statistical (coming soon)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {allocationType === "statistical" && (
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Statistical source account
            </Label>
            <Select
              value={sourceStatId || "__none__"}
              onValueChange={(v) =>
                setSourceStatId(v === "__none__" || v == null ? "" : v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">—</SelectItem>
                {statisticalAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <Checkbox
          checked={isActive}
          onCheckedChange={(c) => setIsActive(!!c)}
        />
        <span>Active (uncheck to disable this allocation)</span>
      </label>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-8"></th>
              <th className="text-left font-medium px-3 py-2">Target account</th>
              <th className="text-right font-medium px-3 py-2 w-32">Percent</th>
              <th className="text-left font-medium px-3 py-2">Memo</th>
              <th className="text-left font-medium px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t, idx) => (
              <tr key={t.id} className="border-t border-border">
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                  {idx + 1}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={t.accountId}
                    onChange={(e) =>
                      updateTarget(t.id, { accountId: e.target.value })
                    }
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
                  <input
                    type="text"
                    inputMode="decimal"
                    value={t.percent}
                    onChange={(e) =>
                      updateTarget(t.id, { percent: e.target.value })
                    }
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-right font-mono"
                    placeholder="0"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={t.memo}
                    onChange={(e) => updateTarget(t.id, { memo: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => removeTarget(t.id)}
                    disabled={targets.length <= 2}
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
              <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Total
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">
                {totalPercent.toFixed(4)}%
              </td>
              <td className="px-3 py-2">
                {percentOk ? (
                  <span className="text-[10px] uppercase tracking-wider text-[var(--gw-green-bright)]">
                    ✓ Sums to 100
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wider text-[var(--gw-amber-bright)]">
                    Δ {(100 - totalPercent).toFixed(4)}%
                  </span>
                )}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div>
        <Button variant="ghost" size="sm" onClick={addTarget}>
          <Plus className="h-3.5 w-3.5" />
          Add target
        </Button>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button
          onClick={submit}
          disabled={
            pending ||
            !percentOk ||
            !code.trim() ||
            !name.trim() ||
            targets.some((t) => !t.accountId)
          }
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create allocation"}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/allocations")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
