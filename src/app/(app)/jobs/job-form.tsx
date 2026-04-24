"use client";

import { useState, useTransition } from "react";
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
import type {
  ContractType,
  Customer,
  Job,
  Profile,
} from "@/lib/db/schema";
import { createJob, updateJob, type JobInput } from "./actions";

type ProfileLite = Pick<Profile, "id" | "email" | "fullName">;

export function JobForm({
  customers,
  contractTypes,
  projectManagers,
  initial,
}: {
  customers: Customer[];
  contractTypes: ContractType[];
  projectManagers: ProfileLite[];
  initial?: Job;
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [projectManagerId, setProjectManagerId] = useState(
    initial?.projectManagerId ?? ""
  );
  const [contractTypeId, setContractTypeId] = useState(initial?.contractTypeId ?? "");
  const [contractAmount, setContractAmount] = useState(initial?.contractAmount ?? "");
  const [contractDate, setContractDate] = useState(initial?.contractDate ?? "");
  const [startDate, setStartDate] = useState(initial?.startDate ?? "");
  const [estimatedEndDate, setEstimatedEndDate] = useState(initial?.estimatedEndDate ?? "");
  const [actualEndDate, setActualEndDate] = useState(initial?.actualEndDate ?? "");
  const [retainagePercent, setRetainagePercent] = useState(initial?.retainagePercent ?? "0");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: JobInput = {
        code: code.trim(),
        name: name.trim(),
        description,
        customerId,
        projectManagerId: projectManagerId || null,
        contractTypeId: contractTypeId || null,
        contractAmount,
        contractDate,
        startDate,
        estimatedEndDate,
        actualEndDate,
        retainagePercent,
        notes,
        isActive,
      };
      const r = isEdit
        ? await updateJob(initial!.id, payload)
        : await createJob(payload);
      if (r.ok) router.push(`/jobs/${r.id}`);
      else setErr(r.error);
    });
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="grid grid-cols-[1fr_2fr] gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Job number
          </Label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="J-001"
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
            placeholder="ACME Warehouse Expansion"
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
            Customer
          </Label>
          <Select
            value={customerId || undefined}
            onValueChange={(v) => setCustomerId(v ?? "")}
          >
            <SelectTrigger>
              <SelectValue placeholder="— choose customer —" />
            </SelectTrigger>
            <SelectContent>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Project manager (optional)
          </Label>
          <Select
            value={projectManagerId || "__none__"}
            onValueChange={(v) =>
              setProjectManagerId(v === "__none__" || v == null ? "" : v)
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— unassigned —</SelectItem>
              {projectManagers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.fullName ? `${p.fullName} (${p.email})` : p.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
          Contract
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Contract type
            </Label>
            <Select
              value={contractTypeId || "__none__"}
              onValueChange={(v) =>
                setContractTypeId(v === "__none__" || v == null ? "" : v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">—</SelectItem>
                {contractTypes
                  .filter((t) => t.isActive)
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Contract amount
            </Label>
            <Input
              inputMode="decimal"
              value={contractAmount}
              onChange={(e) => setContractAmount(e.target.value)}
              placeholder="0.00"
              className="font-mono text-right"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Contract date
            </Label>
            <Input
              type="date"
              value={contractDate}
              onChange={(e) => setContractDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Default retainage %
          </Label>
          <Input
            inputMode="decimal"
            value={retainagePercent}
            onChange={(e) => setRetainagePercent(e.target.value)}
            placeholder="10.0"
            className="font-mono text-right w-32"
          />
        </div>
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
          Schedule
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Start date
            </Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Estimated completion
            </Label>
            <Input
              type="date"
              value={estimatedEndDate}
              onChange={(e) => setEstimatedEndDate(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Actual completion
            </Label>
            <Input
              type="date"
              value={actualEndDate}
              onChange={(e) => setActualEndDate(e.target.value)}
            />
          </div>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <Checkbox checked={isActive} onCheckedChange={(c) => setIsActive(!!c)} />
        <span>Active</span>
      </label>

      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Notes
        </Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button
          onClick={submit}
          disabled={
            pending || !code.trim() || !name.trim() || !customerId
          }
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create job"}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/jobs")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
