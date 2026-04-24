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
import { postPayment, voidPayment } from "../actions";

export function PaymentActions({
  paymentId,
  status,
}: {
  paymentId: string;
  status: "draft" | "posted" | "voided";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [voidOpen, setVoidOpen] = useState(false);

  if (status === "draft") {
    return (
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await postPayment(paymentId);
            if (!r.ok) alert(r.error);
            router.refresh();
          })
        }
      >
        Post to GL
      </Button>
    );
  }

  if (status === "posted") {
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
        <VoidDialog
          open={voidOpen}
          onOpenChange={setVoidOpen}
          onSubmit={(reason) => {
            setVoidOpen(false);
            start(async () => {
              const r = await voidPayment(paymentId, reason);
              if (!r.ok) alert(r.error);
              router.refresh();
            });
          }}
        />
      </>
    );
  }

  return (
    <span className="text-[11px] text-muted-foreground italic">
      Voided — no further actions.
    </span>
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
            VOID POSTED PAYMENT
          </DialogTitle>
          <DialogDescription className="text-xs">
            Creates a reversing GL journal. Bills previously fully paid by
            this payment drop back to posted. Admin role required.
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
          <Button disabled={!reason.trim()} onClick={() => onSubmit(reason.trim())}>
            Void
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
