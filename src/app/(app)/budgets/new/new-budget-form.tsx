"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FiscalYear } from "@/lib/db/schema";
import { createBudget } from "../actions";

export function NewBudgetForm({
  fiscalYears,
}: {
  fiscalYears: FiscalYear[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [fiscalYearId, setFiscalYearId] = useState(fiscalYears[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function submit() {
    setErr(null);
    start(async () => {
      const r = await createBudget({
        fiscalYearId,
        code: code.trim(),
        name: name.trim(),
        description: description.trim(),
      });
      if (r.ok) router.push(`/budgets/${r.id}`);
      else setErr(r.error);
    });
  }

  if (fiscalYears.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        You need a fiscal year before creating a budget.{" "}
        <a href="/periods" className="text-primary hover:underline">
          Generate one first.
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-md">
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Fiscal year
        </Label>
        <Select
          value={fiscalYearId}
          onValueChange={(v) => setFiscalYearId(v ?? "")}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fiscalYears.map((y) => (
              <SelectItem key={y.id} value={y.id}>
                {y.yearLabel} ({y.startDate} — {y.endDate})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Code
        </Label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="PLAN-2026"
          autoFocus
        />
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Name
        </Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="FY2026 Operating Plan"
        />
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Description
        </Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex items-center gap-3 pt-2">
        <Button
          disabled={pending || !fiscalYearId || !code.trim() || !name.trim()}
          onClick={submit}
        >
          {pending ? "Creating…" : "Create budget"}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/budgets")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
