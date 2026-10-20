"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteBankTransaction, postBankTransaction, voidBankTransaction } from "../../actions";

export function TxnActions({ txn }: { txn: { id: string; status: string; txnNumber: string } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.();
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {txn.status === "draft" && (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => deleteBankTransaction(txn.id), () => router.push("/banking/transactions"))}>
              Delete draft
            </Button>
            <Button size="sm" disabled={pending} onClick={() => run(() => postBankTransaction(txn.id))}>
              Post
            </Button>
          </>
        )}
        {txn.status === "posted" && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setVoidOpen(true)}>
            Void
          </Button>
        )}
      </div>
      {err && <p className="text-xs text-destructive max-w-sm text-right">{err}</p>}
      <Dialog open={voidOpen} onOpenChange={setVoidOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void {txn.txnNumber}?</DialogTitle>
            <DialogDescription>
              Posts a reversing entry dated today. A transaction that&apos;s cleared or reconciled can&apos;t be voided until that&apos;s undone.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered twice" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVoidOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={pending || !reason.trim()} onClick={() => run(() => voidBankTransaction(txn.id, reason), () => setVoidOpen(false))}>
              Void
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
