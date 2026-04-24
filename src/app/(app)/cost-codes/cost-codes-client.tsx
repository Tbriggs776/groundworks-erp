"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Plus, Search, Sparkles } from "lucide-react";
import type { CostCode } from "@/lib/db/schema";
import {
  createCostCode,
  seedCsiDivisions,
  updateCostCode,
  type CostCodeInput,
} from "./actions";

const COST_TYPE_LABEL: Record<string, string> = {
  labor: "Labor",
  material: "Material",
  equipment: "Equipment",
  subcontractor: "Subcontractor",
  other: "Other",
  overhead: "Overhead",
  statistical: "Statistical",
};

export function CostCodesClient({ costCodes }: { costCodes: CostCode[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CostCode | null>(null);
  const [seeding, startSeed] = useTransition();

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return costCodes;
    return costCodes.filter(
      (c) =>
        c.code.toLowerCase().includes(s) ||
        c.name.toLowerCase().includes(s) ||
        (c.description ?? "").toLowerCase().includes(s)
    );
  }, [costCodes, q]);

  // Group by parent for hierarchical display
  const tree = useMemo(() => {
    const byParent = new Map<string | null, CostCode[]>();
    for (const c of filtered) {
      const parentId = c.parentCostCodeId ?? null;
      const arr = byParent.get(parentId) ?? [];
      arr.push(c);
      byParent.set(parentId, arr);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) =>
        a.sortOrder !== b.sortOrder
          ? a.sortOrder - b.sortOrder
          : a.code.localeCompare(b.code)
      );
    }
    return byParent;
  }, [filtered]);

  function handleSeed() {
    startSeed(async () => {
      const r = await seedCsiDivisions();
      if (!r.ok) alert(r.error);
      router.refresh();
    });
  }

  const renderRows = (parentId: string | null, depth: number): React.ReactNode[] => {
    const rows = tree.get(parentId) ?? [];
    return rows.flatMap((c) => [
      <tr
        key={c.id}
        onClick={() => {
          setEditing(c);
          setOpen(true);
        }}
        className="border-t border-border hover:bg-accent/30 cursor-pointer"
      >
        <td className="px-3 py-2 font-mono text-xs text-primary">
          <span style={{ paddingLeft: depth * 16 }}>{c.code}</span>
        </td>
        <td className="px-3 py-2">{c.name}</td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {COST_TYPE_LABEL[c.costType] ?? c.costType}
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {c.description}
        </td>
        <td className="px-3 py-2">
          {!c.isActive && (
            <Badge variant="outline" className="text-[9px]">
              Inactive
            </Badge>
          )}
        </td>
      </tr>,
      ...renderRows(c.id, depth + 1),
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search code, name, description…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex gap-2">
          {costCodes.length === 0 && (
            <Button
              variant="ghost"
              onClick={handleSeed}
              disabled={seeding}
              title="Insert all 32 CSI MasterFormat divisions"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {seeding ? "Seeding…" : "Seed CSI MasterFormat"}
            </Button>
          )}
          <Button
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New cost code
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-28">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-32">Type</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-left font-medium px-3 py-2 w-20">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-10 text-center text-xs text-muted-foreground"
                >
                  No cost codes yet.{" "}
                  <button
                    onClick={handleSeed}
                    disabled={seeding}
                    className="text-primary hover:underline"
                  >
                    Seed the CSI MasterFormat defaults
                  </button>
                  {" "}or add your own.
                </td>
              </tr>
            )}
            {renderRows(null, 0)}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {filtered.length} of {costCodes.length} cost codes. Click a row to
        edit.
      </div>

      <CostCodeForm
        open={open}
        onOpenChange={setOpen}
        initial={editing}
        allCostCodes={costCodes}
      />
    </div>
  );
}

function CostCodeForm({
  open,
  onOpenChange,
  initial,
  allCostCodes,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: CostCode | null;
  allCostCodes: CostCode[];
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [parentId, setParentId] = useState(initial?.parentCostCodeId ?? "");
  const [costType, setCostType] = useState<CostCodeInput["costType"]>(
    (initial?.costType ?? "other") as CostCodeInput["costType"]
  );
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  const parentCandidates = allCostCodes.filter((c) => c.id !== initial?.id);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: CostCodeInput = {
        code: code.trim(),
        name: name.trim(),
        description,
        parentCostCodeId: parentId || null,
        costType,
        sortOrder: Number(sortOrder) || 0,
        isActive,
      };
      const r = isEdit
        ? await updateCostCode(initial!.id, payload)
        : await createCostCode(payload);
      if (r.ok) onOpenChange(false);
      else setErr(r.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setErr(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            {isEdit ? "EDIT COST CODE" : "NEW COST CODE"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            A matching value is auto-synced to the COST_CODE system dimension.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Code
              </Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="03 30 00"
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Name
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cast-in-Place Concrete"
                autoFocus
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
                Cost type
              </Label>
              <Select
                value={costType}
                onValueChange={(v) =>
                  setCostType((v ?? "other") as CostCodeInput["costType"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(COST_TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Parent (optional)
            </Label>
            <Select
              value={parentId || "__none__"}
              onValueChange={(v) =>
                setParentId(v === "__none__" || v == null ? "" : v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="— top level —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— top level —</SelectItem>
                {parentCandidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={isActive}
              onCheckedChange={(c) => setIsActive(!!c)}
            />
            <span>Active</span>
          </label>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || !code.trim() || !name.trim()}
            onClick={submit}
          >
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create cost code"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
