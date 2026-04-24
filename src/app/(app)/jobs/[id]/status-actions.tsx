"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
import type { Job } from "@/lib/db/schema";
import { transitionJobStatus } from "../actions";

const LABEL: Record<string, string> = {
  bid: "Bid",
  awarded: "Awarded",
  active: "Active",
  on_hold: "On hold",
  closed: "Closed",
};

const NEXT_OPTIONS: Record<Job["status"], Job["status"][]> = {
  bid: ["awarded", "closed"],
  awarded: ["active", "closed"],
  active: ["on_hold", "closed"],
  on_hold: ["active", "closed"],
  closed: [],
};

export function JobStatusActions({ job }: { job: Job }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [closeOpen, setCloseOpen] = useState(false);

  const options = NEXT_OPTIONS[job.status] ?? [];

  function transition(toStatus: Job["status"], opts: { actualEndDate?: string; note?: string } = {}) {
    start(async () => {
      const r = await transitionJobStatus({
        jobId: job.id,
        toStatus,
        ...opts,
      });
      if (!r.ok) alert(r.error);
      else router.refresh();
    });
  }

  if (options.length === 0) {
    return (
      <span className="text-[11px] text-muted-foreground italic">
        Closed — terminal
      </span>
    );
  }

  return (
    <div className="flex gap-2">
      {options.map((next) => {
        if (next === "closed") {
          return (
            <Button
              key={next}
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setCloseOpen(true)}
            >
              Close
            </Button>
          );
        }
        return (
          <Button
            key={next}
            size="sm"
            variant={next === "active" ? "default" : "ghost"}
            disabled={pending}
            onClick={() => transition(next)}
          >
            Mark {LABEL[next]?.toLowerCase() ?? next}
          </Button>
        );
      })}
      <CloseJobDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        onSubmit={(date, note) => {
          setCloseOpen(false);
          transition("closed", { actualEndDate: date, note });
        }}
      />
    </div>
  );
}

function CloseJobDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (date: string, note: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            CLOSE JOB
          </DialogTitle>
          <DialogDescription className="text-xs">
            Closing is terminal — reopening requires an admin override.
            Actual end date and reason are recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Actual end date
            </Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Reason / note
            </Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(date, note)}>Close job</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
