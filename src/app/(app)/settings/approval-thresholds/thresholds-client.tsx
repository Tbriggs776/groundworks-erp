"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import type { ApprovalThreshold } from "@/lib/db/schema";
import { formatMoney } from "@/lib/money";
import {
  createThreshold,
  deleteThreshold,
  updateThreshold,
  type ThresholdInput,
} from "./actions";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  accountant: "Accountant",
  pm: "PM",
  foreman: "Foreman",
  viewer: "Viewer",
};

export function ThresholdsClient({
  thresholds,
}: {
  thresholds: ApprovalThreshold[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ApprovalThreshold | null>(null);

  function remove(id: string) {
    if (!confirm("Delete this threshold? Bills currently using it will keep their reference.")) return;
    start(async () => {
      const r = await deleteThreshold(id);
      if (!r.ok) alert(r.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div className="text-xs text-muted-foreground max-w-2xl leading-relaxed">
          Amount tiers determine who must approve AP bills.
          <ul className="list-disc ml-4 mt-2 space-y-1">
            <li><code>min</code> is inclusive, <code>max</code> is exclusive.</li>
            <li><code>max</code> blank = unbounded (top tier).</li>
            <li>Required role is a <strong>minimum</strong> — higher ranks always qualify.</li>
            <li>If no active tier matches a bill&apos;s amount, admin is required by default.</li>
          </ul>
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="h-3.5 w-3.5" />
          New tier
        </Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">Tier name</th>
              <th className="text-right font-medium px-3 py-2 w-36">Min</th>
              <th className="text-right font-medium px-3 py-2 w-36">Max</th>
              <th className="text-left font-medium px-3 py-2 w-32">Required role</th>
              <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              <th className="text-right font-medium px-3 py-2 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {thresholds.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                  No tiers configured. Without tiers, admin is required for all bills (default).
                </td>
              </tr>
            )}
            {thresholds.map((t) => (
              <tr key={t.id} className="border-t border-border hover:bg-accent/30">
                <td
                  className="px-3 py-2 cursor-pointer"
                  onClick={() => { setEditing(t); setOpen(true); }}
                >
                  {t.tierName}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(t.minAmount)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {t.maxAmount ? formatMoney(t.maxAmount) : (
                    <span className="text-muted-foreground italic">∞</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  <Badge variant="secondary" className="text-[9px]">
                    {ROLE_LABEL[t.requiredRole] ?? t.requiredRole}+
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  {t.isActive ? (
                    <Badge variant="default" className="text-[9px]">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px]">Inactive</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => remove(t.id)}
                    disabled={pending}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ThresholdForm
        open={open}
        onOpenChange={setOpen}
        initial={editing}
      />
    </div>
  );
}

function ThresholdForm({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: ApprovalThreshold | null;
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [tierName, setTierName] = useState(initial?.tierName ?? "");
  const [minAmount, setMinAmount] = useState(initial?.minAmount ?? "0");
  const [maxAmount, setMaxAmount] = useState(initial?.maxAmount ?? "");
  const [requiredRole, setRequiredRole] = useState<ThresholdInput["requiredRole"]>(
    (initial?.requiredRole ?? "admin") as ThresholdInput["requiredRole"]
  );
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: ThresholdInput = {
        scope: "ap_bill",
        tierName: tierName.trim(),
        minAmount: minAmount || "0",
        maxAmount: maxAmount || "",
        requiredRole,
        sortOrder: Number(sortOrder) || 0,
        isActive,
      };
      const r = isEdit
        ? await updateThreshold(initial!.id, payload)
        : await createThreshold(payload);
      if (r.ok) onOpenChange(false);
      else setErr(r.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) setErr(null); onOpenChange(o); }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            {isEdit ? "EDIT TIER" : "NEW TIER"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Tier name
            </Label>
            <Input
              value={tierName}
              onChange={(e) => setTierName(e.target.value)}
              placeholder="Small / Medium / Large / etc."
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Min amount
              </Label>
              <Input
                inputMode="decimal"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                className="font-mono text-right"
                placeholder="0"
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Max amount (blank = ∞)
              </Label>
              <Input
                inputMode="decimal"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                className="font-mono text-right"
                placeholder="unbounded"
              />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Minimum role required
            </Label>
            <Select
              value={requiredRole}
              onValueChange={(v) =>
                setRequiredRole((v ?? "admin") as ThresholdInput["requiredRole"])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ROLE_LABEL).map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Sort order
              </Label>
              <Input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer pb-2">
              <Checkbox
                checked={isActive}
                onCheckedChange={(c) => setIsActive(!!c)}
              />
              <span>Active</span>
            </label>
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || !tierName.trim()}
            onClick={submit}
          >
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
