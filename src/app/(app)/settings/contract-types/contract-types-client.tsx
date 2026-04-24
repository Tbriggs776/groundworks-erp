"use client";

import { useState, useTransition } from "react";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Trash2, Lock } from "lucide-react";
import type { ContractType } from "@/lib/db/schema";
import {
  createContractType,
  deleteContractType,
  updateContractType,
  type ContractTypeInput,
} from "./actions";

export function ContractTypesClient({ types }: { types: ContractType[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ContractType | null>(null);

  function remove(id: string) {
    if (!confirm("Delete this contract type? Jobs using it will keep their reference.")) return;
    start(async () => {
      const r = await deleteContractType(id);
      if (!r.ok) alert(r.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground max-w-xl leading-relaxed">
          Classify how jobs recognize revenue and bill work. System defaults
          can be renamed and deactivated but not deleted. Custom types you
          add here can be deleted freely.
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="h-3.5 w-3.5" />
          New contract type
        </Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-36">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              <th className="text-right font-medium px-3 py-2 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {types.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-10 text-center text-xs text-muted-foreground"
                >
                  No contract types configured.
                </td>
              </tr>
            )}
            {types.map((t) => (
              <tr key={t.id} className="border-t border-border hover:bg-accent/30">
                <td
                  className="px-3 py-2 font-mono text-xs cursor-pointer"
                  onClick={() => { setEditing(t); setOpen(true); }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-primary">{t.code}</span>
                    {t.isSystem && <Lock className="h-2.5 w-2.5 opacity-60" />}
                  </div>
                </td>
                <td
                  className="px-3 py-2 cursor-pointer"
                  onClick={() => { setEditing(t); setOpen(true); }}
                >
                  {t.name}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {t.description}
                </td>
                <td className="px-3 py-2">
                  {t.isActive ? (
                    <Badge variant="default" className="text-[9px]">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px]">Inactive</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {!t.isSystem && (
                    <button
                      onClick={() => remove(t.id)}
                      disabled={pending}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ContractTypeForm
        open={open}
        onOpenChange={setOpen}
        initial={editing}
      />
    </div>
  );
}

function ContractTypeForm({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: ContractType | null;
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: ContractTypeInput = {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description,
        sortOrder: Number(sortOrder) || 0,
        isActive,
      };
      const r = isEdit
        ? await updateContractType(initial!.id, payload)
        : await createContractType(payload);
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
            {isEdit ? "EDIT CONTRACT TYPE" : "NEW CONTRACT TYPE"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Code (uppercase)
            </Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={isEdit && initial?.isSystem}
              placeholder="DESIGN_BUILD"
            />
            {isEdit && initial?.isSystem && (
              <p className="text-[10px] text-muted-foreground mt-1">
                System contract type — code is locked. Rename the display name instead.
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Name
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Design-Build"
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
                checked={isActive}
                onCheckedChange={(c) => setIsActive(!!c)}
              />
              <span>Active</span>
            </label>
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
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
