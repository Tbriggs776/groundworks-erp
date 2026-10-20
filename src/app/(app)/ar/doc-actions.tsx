"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteSalesDoc, postSalesDoc, voidSalesDoc, type SalesDocKind } from "./sales-actions";

const LIST: Record<SalesDocKind, string> = {
  sales_receipt: "/ar/sales-receipts",
  credit_memo: "/ar/credit-memos",
  refund: "/ar/refunds",
};
const VOID_NOTE: Record<SalesDocKind, string> = {
  sales_receipt: "Posts a reversal dated today. A receipt that's on a deposit can't be voided until the deposit is.",
  credit_memo: "Posts a reversal dated today and takes the credit back off any invoices it paid.",
  refund: "Posts a reversal dated today. A credit refund gives the credit back to the customer.",
};

/** Post / delete a draft; void a posted document. */
export function DocActions({ kind, id, status, number }: { kind: SalesDocKind; id: string; status: string; number: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const posted = status === "posted" || status === "open" || status === "applied";

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
        {status === "draft" && (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => deleteSalesDoc(kind, id), () => router.push(LIST[kind]))}>
              Delete draft
            </Button>
            <Button size="sm" disabled={pending} onClick={() => run(() => postSalesDoc(kind, id))}>
              Post
            </Button>
          </>
        )}
        {posted && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setVoidOpen(true)}>
            Void
          </Button>
        )}
      </div>
      {err && <p className="text-xs text-destructive max-w-sm text-right">{err}</p>}
      <Dialog open={voidOpen} onOpenChange={setVoidOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void {number}?</DialogTitle>
            <DialogDescription>{VOID_NOTE[kind]}</DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered in error" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVoidOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={pending || !reason.trim()} onClick={() => run(() => voidSalesDoc(kind, id, reason), () => setVoidOpen(false))}>
              Void
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
