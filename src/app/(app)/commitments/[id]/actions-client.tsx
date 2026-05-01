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
import {
  closeCommitmentAction,
  deleteDraftCommitment,
  issueCommitmentAction,
  voidCommitmentAction,
} from "../actions";

type Status = "draft" | "issued" | "closed" | "voided";

export function CommitmentActions({
  commitmentId,
  status,
  hasLines,
}: {
  commitmentId: string;
  status: Status;
  hasLines: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [closeOpen, setCloseOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const r = await fn();
      if (!r.ok) alert(r.error);
      router.refresh();
    });
  }

  if (status === "draft") {
    return (
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending || !hasLines}
          onClick={() =>
            run(async () => {
              const r = await issueCommitmentAction(commitmentId);
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            })
          }
          title={!hasLines ? "Add at least one line first" : ""}
        >
          Issue
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (!confirm("Delete this draft commitment?")) return;
            run(async () => {
              const r = await deleteDraftCommitment(commitmentId);
              if (r.ok) router.push("/commitments");
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            });
          }}
        >
          Delete
        </Button>
      </div>
    );
  }

  if (status === "issued") {
    return (
      <>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setCloseOpen(true)}
          >
            Close
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setVoidOpen(true)}
          >
            Void
          </Button>
        </div>
        <ReasonDialog
          open={closeOpen}
          onOpenChange={setCloseOpen}
          title="Close commitment"
          description="Drops remaining un-invoiced amount off the committed bucket. Bills already against this commitment are unaffected."
          confirmLabel="Close"
          required={false}
          onSubmit={(reason) => {
            setCloseOpen(false);
            run(async () => {
              const r = await closeCommitmentAction(commitmentId, reason);
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            });
          }}
        />
        <ReasonDialog
          open={voidOpen}
          onOpenChange={setVoidOpen}
          title="Void commitment"
          description="Reverses remaining commitment. Admin-only. Bills already linked stay linked for history."
          confirmLabel="Void"
          required={true}
          onSubmit={(reason) => {
            setVoidOpen(false);
            run(async () => {
              const r = await voidCommitmentAction(commitmentId, reason);
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            });
          }}
        />
      </>
    );
  }

  return (
    <span className="text-[11px] text-muted-foreground italic capitalize">
      {status === "closed" ? "Closed" : "Voided"} — no further actions.
    </span>
  );
}

function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  required,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  required: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em] uppercase">
            {title}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Reason{required ? "" : " (optional)"}
          </Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={required && !reason.trim()}
            onClick={() => onSubmit(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
