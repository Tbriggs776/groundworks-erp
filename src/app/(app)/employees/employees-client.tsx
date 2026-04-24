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
import { Plus, Search, Link as LinkIcon } from "lucide-react";
import type { Employee, Profile } from "@/lib/db/schema";
import { createEmployee, updateEmployee, type EmployeeInput } from "./actions";

const CLASSIFICATION_LABEL: Record<string, string> = {
  salary: "Salary",
  hourly: "Hourly",
  union: "Union",
  contractor_1099: "1099 Contractor",
  owner_officer: "Owner / Officer",
};

type LinkableUser = Pick<Profile, "id" | "email" | "fullName">;

export function EmployeesClient({
  employees,
  linkableUsers,
}: {
  employees: Array<Employee & { linkedUser: LinkableUser | null }>;
  linkableUsers: LinkableUser[];
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<
    (Employee & { linkedUser: LinkableUser | null }) | null
  >(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return employees;
    return employees.filter(
      (e) =>
        e.code.toLowerCase().includes(s) ||
        `${e.firstName} ${e.lastName}`.toLowerCase().includes(s) ||
        (e.email ?? "").toLowerCase().includes(s)
    );
  }, [employees, q]);

  // For the form: exclude users already linked to other employees (unless
  // editing that same employee, in which case their current link is fine).
  const linkableForEditing = useMemo(() => {
    const linkedElsewhere = new Set(
      employees
        .filter((e) => e.id !== editing?.id && e.userId)
        .map((e) => e.userId!)
    );
    return linkableUsers.filter((u) => !linkedElsewhere.has(u.id));
  }, [linkableUsers, employees, editing]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by code, name, or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="h-3.5 w-3.5" />
          New employee
        </Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-24">Code</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-40">Classification</th>
              <th className="text-left font-medium px-3 py-2">Email</th>
              <th className="text-left font-medium px-3 py-2 w-32">Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-xs text-muted-foreground">
                  No employees match.
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr
                key={e.id}
                onClick={() => { setEditing(e); setOpen(true); }}
                className="border-t border-border hover:bg-accent/30 cursor-pointer"
              >
                <td className="px-3 py-2 font-mono text-xs text-primary">{e.code}</td>
                <td className="px-3 py-2">
                  <div>
                    {e.displayName || `${e.firstName} ${e.lastName}`}
                  </div>
                  {e.linkedUser && (
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <LinkIcon className="h-2.5 w-2.5" />
                      Logs in as {e.linkedUser.email}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {CLASSIFICATION_LABEL[e.classification] ?? e.classification}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{e.email}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1 flex-wrap">
                    {!e.isActive && <Badge variant="outline" className="text-[9px]">Inactive</Badge>}
                    {e.terminationDate && (
                      <Badge variant="destructive" className="text-[9px]">Terminated</Badge>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {filtered.length} of {employees.length} employees.
      </div>

      <EmployeeForm
        open={open}
        onOpenChange={setOpen}
        initial={editing}
        linkableUsers={linkableForEditing}
      />
    </div>
  );
}

function EmployeeForm({
  open,
  onOpenChange,
  initial,
  linkableUsers,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: Employee | null;
  linkableUsers: LinkableUser[];
}) {
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [firstName, setFirstName] = useState(initial?.firstName ?? "");
  const [lastName, setLastName] = useState(initial?.lastName ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [userId, setUserId] = useState<string>(initial?.userId ?? "");
  const [classification, setClassification] = useState<EmployeeInput["classification"]>(
    (initial?.classification ?? "hourly") as EmployeeInput["classification"]
  );
  const [defaultRate, setDefaultRate] = useState(initial?.defaultRate ?? "");
  const [hireDate, setHireDate] = useState(initial?.hireDate ?? "");
  const [terminationDate, setTerminationDate] = useState(initial?.terminationDate ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [ssnLast4, setSsnLast4] = useState(initial?.ssnLast4 ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: EmployeeInput = {
        code: code.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        displayName: displayName.trim(),
        userId: userId || null,
        classification,
        defaultRate,
        hireDate,
        terminationDate,
        email,
        phone,
        ssnLast4,
        notes,
        isActive,
        addresses: [],
      };
      const r = isEdit
        ? await updateEmployee(initial!.id, payload)
        : await createEmployee(payload);
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
            {isEdit ? "EDIT EMPLOYEE" : "NEW EMPLOYEE"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_2fr_2fr] gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="EMP-001" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">First name</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Last name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Display name (optional)</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Mike J." />
          </div>

          <div className="border-t border-border pt-3 space-y-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
              Link to app user (optional)
            </div>
            <Select
              value={userId || "__none__"}
              onValueChange={(v) => setUserId(v === "__none__" || v == null ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— no login, field-only —</SelectItem>
                {linkableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName ? `${u.fullName} (${u.email})` : u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Field crew who never log in can be left unlinked. If this employee
              logs into Groundworks, pick their account here so their actions
              are attributed correctly.
            </p>
          </div>

          <div className="border-t border-border pt-3 space-y-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
              Payroll
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Classification</Label>
                <Select
                  value={classification}
                  onValueChange={(v) =>
                    setClassification((v ?? "hourly") as EmployeeInput["classification"])
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CLASSIFICATION_LABEL).map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Default rate</Label>
                <Input
                  inputMode="decimal"
                  value={defaultRate}
                  onChange={(e) => setDefaultRate(e.target.value)}
                  className="font-mono text-right"
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">SSN (last 4)</Label>
                <Input
                  value={ssnLast4}
                  onChange={(e) => setSsnLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  maxLength={4}
                  placeholder="1234"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Hire date</Label>
                <Input type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Termination date</Label>
                <Input type="date" value={terminationDate} onChange={(e) => setTerminationDate(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Phone</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs cursor-pointer">
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
          <Button
            disabled={pending || !code.trim() || !firstName.trim() || !lastName.trim()}
            onClick={submit}
          >
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create employee"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
