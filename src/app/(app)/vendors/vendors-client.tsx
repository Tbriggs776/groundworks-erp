"use client";

import { useMemo, useState, useTransition } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Search } from "lucide-react";
import type { Vendor } from "@/lib/db/schema";
import { createVendor, updateVendor, type VendorInput } from "./actions";

const TYPE_LABEL: Record<string, string> = {
  subcontractor: "Subcontractor",
  supplier: "Supplier",
  service_provider: "Service provider",
  tax_authority: "Tax authority",
  utility: "Utility",
  other: "Other",
};

export function VendorsClient({ vendors }: { vendors: Vendor[] }) {
  const [q, setQ] = useState("");
  const [only1099, setOnly1099] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return vendors.filter((v) => {
      if (only1099 && !v.is1099Vendor) return false;
      if (!s) return true;
      return (
        v.code.toLowerCase().includes(s) ||
        v.name.toLowerCase().includes(s) ||
        (v.displayName ?? "").toLowerCase().includes(s)
      );
    });
  }, [vendors, q, only1099]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by code or name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox checked={only1099} onCheckedChange={(c) => setOnly1099(!!c)} />
            <span>1099 only</span>
          </label>
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="h-3.5 w-3.5" />
          New vendor
        </Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-28">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-36">Type</th>
              <th className="text-right font-medium px-3 py-2 w-24">Terms</th>
              <th className="text-left font-medium px-3 py-2 w-40">Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-xs text-muted-foreground">
                  No vendors match.
                </td>
              </tr>
            )}
            {filtered.map((v) => (
              <tr
                key={v.id}
                onClick={() => { setEditing(v); setOpen(true); }}
                className="border-t border-border hover:bg-accent/30 cursor-pointer"
              >
                <td className="px-3 py-2 font-mono text-xs text-primary">{v.code}</td>
                <td className="px-3 py-2">
                  <div>{v.name}</div>
                  {v.displayName && <div className="text-[11px] text-muted-foreground">{v.displayName}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {TYPE_LABEL[v.vendorType] ?? v.vendorType}
                </td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                  Net {v.defaultPaymentTermsDays}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1 flex-wrap">
                    {!v.isActive && <Badge variant="outline" className="text-[9px]">Inactive</Badge>}
                    {v.is1099Vendor && <Badge variant="secondary" className="text-[9px]">1099</Badge>}
                    {v.is1099Vendor && !v.w9OnFile && <Badge variant="destructive" className="text-[9px]">W-9 missing</Badge>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {filtered.length} of {vendors.length} vendors.
      </div>

      <VendorForm open={open} onOpenChange={setOpen} initial={editing} />
    </div>
  );
}

function VendorForm({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: Vendor | null;
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [vendorType, setVendorType] = useState<VendorInput["vendorType"]>(
    (initial?.vendorType ?? "supplier") as VendorInput["vendorType"]
  );
  const [terms, setTerms] = useState(String(initial?.defaultPaymentTermsDays ?? 30));
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [is1099Vendor, setIs1099Vendor] = useState(initial?.is1099Vendor ?? false);
  const [tin, setTin] = useState(initial?.tin ?? "");
  const [w9OnFile, setW9OnFile] = useState(initial?.w9OnFile ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: VendorInput = {
        code: code.trim(),
        name: name.trim(),
        displayName: displayName.trim(),
        vendorType,
        defaultPaymentTermsDays: Number(terms) || 30,
        currency: currency.toUpperCase(),
        is1099Vendor,
        tin,
        w9OnFile,
        notes,
        isActive,
        addresses: [],
        contacts: [],
      };
      const r = isEdit
        ? await updateVendor(initial!.id, payload)
        : await createVendor(payload);
      if (r.ok) onOpenChange(false);
      else setErr(r.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) setErr(null); onOpenChange(o); }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            {isEdit ? "EDIT VENDOR" : "NEW VENDOR"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="VEND-001" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ABC Concrete Supply" autoFocus />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Display name</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="ABC Concrete" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Type</Label>
              <Select
                value={vendorType}
                onValueChange={(v) => setVendorType((v ?? "supplier") as VendorInput["vendorType"])}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Terms (days)</Label>
              <Input type="number" value={terms} onChange={(e) => setTerms(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Currency</Label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} className="uppercase" />
            </div>
          </div>
          <div className="border-t border-border pt-3 space-y-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
              1099 / Tax
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox checked={is1099Vendor} onCheckedChange={(c) => setIs1099Vendor(!!c)} />
                <span>Requires 1099-NEC at year-end</span>
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox checked={w9OnFile} onCheckedChange={(c) => setW9OnFile(!!c)} />
                <span>W-9 on file</span>
              </label>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                TIN / EIN {is1099Vendor && <span className="text-destructive">*</span>}
              </Label>
              <Input value={tin} onChange={(e) => setTin(e.target.value)} placeholder="XX-XXXXXXX" />
              <p className="text-[10px] text-muted-foreground mt-1">
                Stored as plaintext in v1. Move to encrypted at-rest when tax module lands.
              </p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer pt-1">
            <Checkbox checked={isActive} onCheckedChange={(c) => setIsActive(!!c)} />
            <span>Active</span>
          </label>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending || !code.trim() || !name.trim()} onClick={submit}>
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create vendor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
