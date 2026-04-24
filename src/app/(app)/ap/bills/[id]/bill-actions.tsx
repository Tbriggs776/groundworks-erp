"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import type { ApBill } from "@/lib/db/schema";
import {
  approveBill,
  postBill,
  rejectBill,
  submitForApproval,
  voidBill,
} from "../actions";

export function BillActions({ bill }: { bill: ApBill }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);

  function call(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const r = await fn();
      if (!r.ok && r.error) alert(r.error);
      router.refresh();
    });
  }

  switch (bill.status) {
    case "draft":
    case "rejected":
      return (
        <div className="flex gap-2">
          <Link
            href={`/ap/bills/${bill.id}/edit`}
            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
          >
            Edit
          </Link>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => call(() => submitForApproval(bill.id))}
          >
            Submit for approval
          </Button>
        </div>
      );
    case "pending_approval":
      return (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setRejectOpen(true)}
          >
            Reject
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => call(() => approveBill(bill.id))}
          >
            Approve
          </Button>
          <RejectDialog
            open={rejectOpen}
            onOpenChange={setRejectOpen}
            onSubmit={(reason) => {
              setRejectOpen(false);
              call(() => rejectBill(bill.id, reason));
            }}
          />
        </div>
      );
    case "approved":
      return (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => call(() => postBill(bill.id))}
          >
            Post to GL
          </Button>
        </div>
      );
    case "posted":
      return (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setVoidOpen(true)}
          >
            Void
          </Button>
          <VoidDialog
            open={voidOpen}
            onOpenChange={setVoidOpen}
            onSubmit={(reason) => {
              setVoidOpen(false);
              call(() => voidBill(bill.id, reason));
            }}
          />
        </div>
      );
    default:
      return (
        <span className="text-[11px] text-muted-foreground italic">
          No actions available.
        </span>
      );
  }
}

function RejectDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            REJECT BILL
          </DialogTitle>
          <DialogDescription className="text-xs">
            Rejecting sends the bill back to draft. The reason is recorded in
            the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Reason
          </Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!reason.trim()}
            onClick={() => onSubmit(reason.trim())}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoidDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            VOID POSTED BILL
          </DialogTitle>
          <DialogDescription className="text-xs">
            Voiding creates a reversing GL journal. The original stays in the
            ledger for audit. Admin role required.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Reason
          </Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!reason.trim()}
            onClick={() => onSubmit(reason.trim())}
          >
            Void
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
