"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FiscalPeriod, FiscalYear } from "@/lib/db/schema";
import { generateFiscalYear, transitionPeriodStatus } from "./actions";

type YearWithPeriods = FiscalYear & { periods: FiscalPeriod[] };

type Props = {
  years: YearWithPeriods[];
  nextSuggestedYear: { label: string; startDate: string };
};

export function PeriodsClient({ years, nextSuggestedYear }: Props) {
  const [genOpen, setGenOpen] = useState(false);
  const [activeYearId, setActiveYearId] = useState<string | null>(
    years[0]?.id ?? null
  );

  const activeYear = years.find((y) => y.id === activeYearId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1 overflow-x-auto">
          {years.map((y) => (
            <button
              key={y.id}
              onClick={() => setActiveYearId(y.id)}
              className={`px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
                y.id === activeYearId
                  ? "bg-primary/10 text-primary border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-ring"
              }`}
            >
              {y.yearLabel}
              <span className="text-[9px] ml-2 opacity-70">
                {y.startDate.slice(0, 4)}
              </span>
            </button>
          ))}
          {years.length === 0 && (
            <div className="text-xs text-muted-foreground">
              No fiscal years yet. Generate one to get started.
            </div>
          )}
        </div>
        <Button onClick={() => setGenOpen(true)}>Generate fiscal year</Button>
      </div>

      {activeYear && <PeriodsTable periods={activeYear.periods} />}

      <GenerateYearDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        defaultLabel={nextSuggestedYear.label}
        defaultStart={nextSuggestedYear.startDate}
      />
    </div>
  );
}

function PeriodsTable({ periods }: { periods: FiscalPeriod[] }) {
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium px-3 py-2 w-16">No.</th>
            <th className="text-left font-medium px-3 py-2">Code</th>
            <th className="text-left font-medium px-3 py-2 w-48">Range</th>
            <th className="text-left font-medium px-3 py-2 w-32">Status</th>
            <th className="text-right font-medium px-3 py-2 w-48">Actions</th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id} className="border-t border-border">
              <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                {p.periodNo}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-primary">
                {p.periodCode}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {p.startDate} — {p.endDate}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={p.status} />
              </td>
              <td className="px-3 py-2">
                <PeriodActions period={p} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: FiscalPeriod["status"] }) {
  if (status === "open") {
    return (
      <Badge variant="outline" className="text-[9px]">
        Open
      </Badge>
    );
  }
  if (status === "soft_closed") {
    return (
      <Badge variant="secondary" className="text-[9px]">
        Soft Closed
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="text-[9px]">
      Hard Closed
    </Badge>
  );
}

function PeriodActions({ period }: { period: FiscalPeriod }) {
  const [pending, start] = useTransition();
  const [hardOpen, setHardOpen] = useState(false);

  function to(toStatus: FiscalPeriod["status"], opts?: { password?: string; reason?: string }) {
    start(async () => {
      const r = await transitionPeriodStatus({
        periodId: period.id,
        toStatus,
        ...opts,
      });
      if (!r.ok) alert(r.error);
    });
  }

  if (period.status === "open") {
    return (
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => to("soft_closed")}
        >
          Soft close
        </Button>
      </div>
    );
  }
  if (period.status === "soft_closed") {
    return (
      <div className="flex justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => to("open")}
        >
          Reopen
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setHardOpen(true)}
        >
          Hard close
        </Button>
        <HardCloseDialog
          open={hardOpen}
          onOpenChange={setHardOpen}
          onSubmit={(password, reason) => {
            setHardOpen(false);
            to("hard_closed", { password, reason });
          }}
        />
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          const password = prompt("Override password:");
          const reason = prompt("Reason for reopening:");
          if (password && reason) to("soft_closed", { password, reason });
        }}
      >
        Reopen
      </Button>
    </div>
  );
}

function HardCloseDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (password: string, reason: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            HARD CLOSE PERIOD
          </DialogTitle>
          <DialogDescription className="text-xs">
            Hard-closed periods reject new posts unless an override password
            is provided. Reason is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Override password
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Reason
            </Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!password || !reason.trim()}
            onClick={() => onSubmit(password, reason.trim())}
          >
            Hard close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GenerateYearDialog({
  open,
  onOpenChange,
  defaultLabel,
  defaultStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLabel: string;
  defaultStart: string;
}) {
  const [label, setLabel] = useState(defaultLabel);
  const [startDate, setStartDate] = useState(defaultStart);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    start(async () => {
      const r = await generateFiscalYear({ yearLabel: label, startDate });
      if (!r.ok) setErr(r.error);
      else onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            GENERATE FISCAL YEAR
          </DialogTitle>
          <DialogDescription className="text-xs">
            Creates a new fiscal year and 12 monthly periods (open by default).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Year label
            </Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Start date (first of month)
            </Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={submit}>
            {pending ? "Generating…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
