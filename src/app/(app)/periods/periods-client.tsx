"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
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
import { generateFiscalYear } from "./actions";

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
    <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium px-3 py-2 w-16">No.</th>
            <th className="text-left font-medium px-3 py-2">Code</th>
            <th className="text-left font-medium px-3 py-2 w-48">Range</th>
            <th className="text-left font-medium px-3 py-2 w-32">Status</th>
            <th className="text-left font-medium px-3 py-2">Closed</th>
            <th className="text-right font-medium px-3 py-2 w-32"></th>
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
                {p.startDate} to {p.endDate}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={p.status} />
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {p.closedAt ? new Date(p.closedAt).toLocaleDateString() : ""}
                {p.closeNote && <span title={p.closeNote}> · with a note</span>}
              </td>
              <td className="px-3 py-2 text-right">
                <Link href={`/periods/${p.id}`} className="text-xs text-primary hover:underline whitespace-nowrap">
                  Checklist →
                </Link>
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
      <DialogContent className="sm:max-w-md">
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
