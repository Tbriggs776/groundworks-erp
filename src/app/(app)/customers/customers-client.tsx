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
import type { Customer } from "@/lib/db/schema";
import {
  createCustomer,
  updateCustomer,
  type CustomerInput,
} from "./actions";

const TYPE_LABEL: Record<string, string> = {
  commercial: "Commercial",
  residential: "Residential",
  government: "Government",
  non_profit: "Non-profit",
  tax_exempt: "Tax-exempt",
};

export function CustomersClient({ customers }: { customers: Customer[] }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter(
      (c) =>
        c.code.toLowerCase().includes(s) ||
        c.name.toLowerCase().includes(s) ||
        (c.displayName ?? "").toLowerCase().includes(s)
    );
  }, [customers, q]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by code or name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          New customer
        </Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-28">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-32">Type</th>
              <th className="text-right font-medium px-3 py-2 w-24">Terms</th>
              <th className="text-left font-medium px-3 py-2 w-24">Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-xs text-muted-foreground">
                  No customers match.
                </td>
              </tr>
            )}
            {filtered.map((c) => (
              <tr
                key={c.id}
                onClick={() => {
                  setEditing(c);
                  setOpen(true);
                }}
                className="border-t border-border hover:bg-accent/30 cursor-pointer"
              >
                <td className="px-3 py-2 font-mono text-xs text-primary">{c.code}</td>
                <td className="px-3 py-2">
                  <div>{c.name}</div>
                  {c.displayName && (
                    <div className="text-[11px] text-muted-foreground">
                      {c.displayName}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {TYPE_LABEL[c.customerType] ?? c.customerType}
                </td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                  Net {c.defaultPaymentTermsDays}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1 flex-wrap">
                    {!c.isActive && (
                      <Badge variant="outline" className="text-[9px]">Inactive</Badge>
                    )}
                    {c.taxExempt && (
                      <Badge variant="secondary" className="text-[9px]">Tax-exempt</Badge>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {filtered.length} of {customers.length} customers.
      </div>

      <CustomerForm open={open} onOpenChange={setOpen} initial={editing} />
    </div>
  );
}

function CustomerForm({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: Customer | null;
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [customerType, setCustomerType] = useState<CustomerInput["customerType"]>(
    (initial?.customerType ?? "commercial") as CustomerInput["customerType"]
  );
  const [terms, setTerms] = useState(String(initial?.defaultPaymentTermsDays ?? 30));
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [creditLimit, setCreditLimit] = useState(initial?.creditLimit ?? "");
  const [taxExempt, setTaxExempt] = useState(initial?.taxExempt ?? false);
  const [taxId, setTaxId] = useState(initial?.taxId ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: CustomerInput = {
        code: code.trim(),
        name: name.trim(),
        displayName: displayName.trim(),
        customerType,
        defaultPaymentTermsDays: Number(terms) || 30,
        currency: currency.toUpperCase(),
        creditLimit,
        taxExempt,
        taxId,
        notes,
        isActive,
        addresses: [],
        contacts: [],
      };
      const r = isEdit
        ? await updateCustomer(initial!.id, payload)
        : await createCustomer(payload);
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            {isEdit ? "EDIT CUSTOMER" : "NEW CUSTOMER"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CUST-001" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ACME Building Corp" autoFocus />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Display name</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="ACME" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Type</Label>
              <Select
                value={customerType}
                onValueChange={(v) => setCustomerType((v ?? "commercial") as CustomerInput["customerType"])}
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Credit limit (optional)</Label>
              <Input inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} className="font-mono text-right" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Tax ID (EIN / SSN)</Label>
              <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 items-center pt-1">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox checked={taxExempt} onCheckedChange={(c) => setTaxExempt(!!c)} />
              <span>Tax-exempt</span>
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox checked={isActive} onCheckedChange={(c) => setIsActive(!!c)} />
              <span>Active</span>
            </label>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending || !code.trim() || !name.trim()} onClick={submit}>
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
