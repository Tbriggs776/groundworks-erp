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
  approveChangeOrder,
  deleteDraftChangeOrder,
  executeApprovedChangeOrder,
  rejectChangeOrder,
  reopenChangeOrder,
  submitChangeOrder,
  voidChangeOrder,
} from "../actions";

type Status =
  | "draft"
  | "pending_approval"
  | "rejected"
  | "approved"
  | "executed"
  | "voided";

export function ChangeOrderActions({
  jobId,
  changeOrderId,
  status,
  hasLines,
}: {
  jobId: string;
  changeOrderId: string;
  status: Status;
  hasLines: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
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
              const r = await submitChangeOrder(changeOrderId);
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            })
          }
          title={!hasLines ? "Add at least one line first" : ""}
        >
          Submit for approval
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (!confirm("Delete this draft change order?")) return;
            run(async () => {
              const r = await deleteDraftChangeOrder(changeOrderId);
              if (r.ok) router.push(`/jobs/${jobId}/change-orders`);
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            });
          }}
        >
          Delete
        </Button>
      </div>
    );
  }

  if (status === "pending_approval") {
    return (
      <>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const r = await approveChangeOrder(changeOrderId);
                return { ok: r.ok, error: r.ok ? undefined : r.error };
              })
            }
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setRejectOpen(true)}
          >
            Reject
          </Button>
        </div>
        <ReasonDialog
          open={rejectOpen}
          onOpenChange={setRejectOpen}
          title="Reject change order"
          description="The CO will return to the requester with this reason."
          confirmLabel="Reject"
          onSubmit={(reason) => {
            setRejectOpen(false);
            run(async () => {
              const r = await rejectChangeOrder(changeOrderId, reason);
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            });
          }}
        />
      </>
    );
  }

  if (status === "rejected") {
    return (
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          run(async () => {
            const r = await reopenChangeOrder(changeOrderId);
            return { ok: r.ok, error: r.ok ? undefined : r.error };
          })
        }
      >
        Reopen for editing
      </Button>
    );
  }

  if (status === "approved") {
    return (
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          run(async () => {
            const r = await executeApprovedChangeOrder(changeOrderId);
            return { ok: r.ok, error: r.ok ? undefined : r.error };
          })
        }
      >
        Execute (apply to budget)
      </Button>
    );
  }

  if (status === "executed") {
    return (
      <>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setVoidOpen(true)}
        >
          Void
        </Button>
        <ReasonDialog
          open={voidOpen}
          onOpenChange={setVoidOpen}
          title="Void executed change order"
          description="Reverses the contract adjustment and budget bumps. Admin role required."
          confirmLabel="Void"
          onSubmit={(reason) => {
            setVoidOpen(false);
            run(async () => {
              const r = await voidChangeOrder(changeOrderId, reason);
              return { ok: r.ok, error: r.ok ? undefined : r.error };
            });
          }}
        />
      </>
    );
  }

  // voided — terminal
  return (
    <span className="text-[11px] text-muted-foreground italic">
      Voided — no further actions.
    </span>
  );
}

function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
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
            Reason
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
            disabled={!reason.trim()}
            onClick={() => onSubmit(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
