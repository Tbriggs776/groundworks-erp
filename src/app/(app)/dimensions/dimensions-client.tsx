"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
import { Plus, Lock } from "lucide-react";
import type { Dimension, DimensionValue } from "@/lib/db/schema";
import {
  createDimension,
  createDimensionValue,
  updateDimension,
  updateDimensionValue,
} from "./actions";

type Props = {
  dimensions: Dimension[];
  values: DimensionValue[];
};

export function DimensionsClient({ dimensions, values }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    dimensions[0]?.id ?? null
  );
  const [dimFormOpen, setDimFormOpen] = useState(false);
  const [editingDim, setEditingDim] = useState<Dimension | null>(null);
  const [valueFormOpen, setValueFormOpen] = useState(false);
  const [editingValue, setEditingValue] = useState<DimensionValue | null>(null);

  const selected = useMemo(
    () => dimensions.find((d) => d.id === selectedId) ?? null,
    [dimensions, selectedId]
  );
  const valuesInSelected = useMemo(() => {
    if (!selectedId) return [];
    return values.filter((v) => v.dimensionId === selectedId);
  }, [values, selectedId]);

  return (
    <div className="grid grid-cols-[280px_1fr] gap-4 min-h-[600px]">
      <aside className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Dimensions
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditingDim(null);
              setDimFormOpen(true);
            }}
            className="h-6 px-2"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        <div className="space-y-1 rounded-md border border-border bg-card">
          {dimensions.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelectedId(d.id)}
              className={`w-full text-left px-3 py-2 text-sm border-l-2 transition-colors ${
                d.id === selectedId
                  ? "bg-primary/10 text-primary border-primary"
                  : "text-foreground border-transparent hover:bg-accent/30"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] opacity-70">
                  {d.code}
                </span>
                {d.isSystem && (
                  <Lock className="h-2.5 w-2.5 opacity-60" />
                )}
              </div>
              <div className="truncate">{d.name}</div>
              {d.isBlocked && (
                <Badge variant="destructive" className="text-[9px] mt-1">
                  Blocked
                </Badge>
              )}
            </button>
          ))}
          {dimensions.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              No dimensions yet.
            </div>
          )}
        </div>
      </aside>

      <section className="space-y-3">
        {selected ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-heading text-xl tracking-[0.12em]">
                    {selected.name.toUpperCase()}
                  </h2>
                  {selected.isSystem && (
                    <Badge variant="secondary" className="text-[9px]">
                      System
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Code: <span className="font-mono">{selected.code}</span>
                  {selected.description && (
                    <span> · {selected.description}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditingDim(selected);
                    setDimFormOpen(true);
                  }}
                >
                  Edit dimension
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingValue(null);
                    setValueFormOpen(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  New value
                </Button>
              </div>
            </div>

            <ValueTree
              values={valuesInSelected}
              onEdit={(v) => {
                setEditingValue(v);
                setValueFormOpen(true);
              }}
            />
          </>
        ) : (
          <div className="text-sm text-muted-foreground pt-10">
            Select or create a dimension to edit its values.
          </div>
        )}
      </section>

      <DimensionForm
        open={dimFormOpen}
        onOpenChange={setDimFormOpen}
        initial={editingDim}
      />
      {selected && (
        <DimensionValueForm
          open={valueFormOpen}
          onOpenChange={setValueFormOpen}
          dimensionId={selected.id}
          values={valuesInSelected}
          initial={editingValue}
        />
      )}
    </div>
  );
}

function ValueTree({
  values,
  onEdit,
}: {
  values: DimensionValue[];
  onEdit: (v: DimensionValue) => void;
}) {
  // Group by parent, then render in hierarchical order
  const byParent = useMemo(() => {
    const map = new Map<string | null, DimensionValue[]>();
    for (const v of values) {
      const key = v.parentValueId ?? null;
      const arr = map.get(key) ?? [];
      arr.push(v);
      map.set(key, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) =>
        a.sortOrder !== b.sortOrder
          ? a.sortOrder - b.sortOrder
          : a.code.localeCompare(b.code)
      );
    }
    return map;
  }, [values]);

  function renderLevel(parentId: string | null, depth: number): React.ReactNode {
    const rows = byParent.get(parentId) ?? [];
    if (rows.length === 0 && parentId === null) {
      return (
        <tr>
          <td
            colSpan={4}
            className="px-3 py-8 text-center text-xs text-muted-foreground"
          >
            No values yet. Add the first one.
          </td>
        </tr>
      );
    }
    return rows.flatMap((v) => [
      <tr
        key={v.id}
        onClick={() => onEdit(v)}
        className="border-t border-border hover:bg-accent/30 cursor-pointer transition-colors"
      >
        <td className="px-3 py-2 font-mono text-xs text-primary">
          <span style={{ paddingLeft: depth * 16 }}>{v.code}</span>
        </td>
        <td className="px-3 py-2">{v.name}</td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {v.description}
        </td>
        <td className="px-3 py-2">
          <div className="flex gap-1 flex-wrap">
            {v.isBlocked && (
              <Badge variant="destructive" className="text-[9px]">
                Blocked
              </Badge>
            )}
            {v.isTotal && (
              <Badge variant="secondary" className="text-[9px]">
                Total
              </Badge>
            )}
          </div>
        </td>
      </tr>,
      ...((renderLevel(v.id, depth + 1) as React.ReactNode[]) ?? []),
    ]);
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium px-3 py-2 w-32">Code</th>
            <th className="text-left font-medium px-3 py-2">Name</th>
            <th className="text-left font-medium px-3 py-2">Description</th>
            <th className="text-left font-medium px-3 py-2 w-32">Flags</th>
          </tr>
        </thead>
        <tbody>{renderLevel(null, 0)}</tbody>
      </table>
    </div>
  );
}

function DimensionForm({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: Dimension | null;
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const [isBlocked, setIsBlocked] = useState(initial?.isBlocked ?? false);

  // Sync when `initial` changes
  if (open && initial && initial.id !== (initial as Dimension | null)?.id) {
    // no-op guard; form state reset happens on openChange
  }

  function submit() {
    setErr(null);
    start(async () => {
      const payload = {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim(),
        sortOrder: Number(sortOrder) || 0,
        isBlocked,
      };
      const r = isEdit
        ? await updateDimension(initial!.id, payload)
        : await createDimension(payload);
      if (r.ok) onOpenChange(false);
      else setErr(r.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setCode("");
          setName("");
          setDescription("");
          setSortOrder("0");
          setIsBlocked(false);
          setErr(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            {isEdit ? "EDIT DIMENSION" : "NEW DIMENSION"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit && initial?.isSystem
              ? "This is a system dimension — the code is locked but the display name can be customized."
              : "Dimensions slice journal lines for analytical reporting."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Code (uppercase, underscores allowed)
            </Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={isEdit && initial?.isSystem}
              placeholder="DEPARTMENT"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Display name
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Department"
              autoFocus
            />
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
                Sort order
              </Label>
              <Input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </div>
            <label className="flex items-end gap-2 text-xs cursor-pointer pb-2">
              <Checkbox
                checked={isBlocked}
                onCheckedChange={(c) => setIsBlocked(!!c)}
              />
              <span>Blocked (prevent new usage)</span>
            </label>
          </div>
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
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DimensionValueForm({
  open,
  onOpenChange,
  dimensionId,
  values,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dimensionId: string;
  values: DimensionValue[];
  initial: DimensionValue | null;
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [parentValueId, setParentValueId] = useState(
    initial?.parentValueId ?? ""
  );
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const [isBlocked, setIsBlocked] = useState(initial?.isBlocked ?? false);
  const [isTotal, setIsTotal] = useState(initial?.isTotal ?? false);

  // Candidate parents: other values in the same dimension, excluding self
  const parentCandidates = useMemo(
    () => values.filter((v) => v.id !== initial?.id),
    [values, initial?.id]
  );

  function submit() {
    setErr(null);
    start(async () => {
      const payload = {
        dimensionId,
        code: code.trim(),
        name: name.trim(),
        description: description.trim(),
        parentValueId: parentValueId || null,
        sortOrder: Number(sortOrder) || 0,
        isBlocked,
        isTotal,
      };
      const r = isEdit
        ? await updateDimensionValue(initial!.id, payload)
        : await createDimensionValue(payload);
      if (r.ok) onOpenChange(false);
      else setErr(r.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setCode("");
          setName("");
          setDescription("");
          setParentValueId("");
          setSortOrder("0");
          setIsBlocked(false);
          setIsTotal(false);
          setErr(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            {isEdit ? "EDIT VALUE" : "NEW VALUE"}
          </DialogTitle>
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
                placeholder="ADMIN"
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Name
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Administration"
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
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Parent value (optional)
            </Label>
            <Select
              value={parentValueId || "__none__"}
              onValueChange={(v) =>
                setParentValueId(v === "__none__" || v == null ? "" : v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— top level —</SelectItem>
                {parentCandidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3 items-end">
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
                checked={isBlocked}
                onCheckedChange={(c) => setIsBlocked(!!c)}
              />
              <span>Blocked</span>
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer pb-2">
              <Checkbox
                checked={isTotal}
                onCheckedChange={(c) => setIsTotal(!!c)}
              />
              <span>Rollup only</span>
            </label>
          </div>
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
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
