"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteInvoice, postInvoice, voidInvoice } from "../actions";

export function InvoiceActions({
  invoice,
}: {
  invoice: { id: string; status: string; customerId: string; invoiceNumber: string };
}) {
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
      <div className="flex flex-wrap justify-end gap-2">
        {invoice.status === "draft" && (
          <>
            <Link
              href={`/ar/invoices/${invoice.id}/edit`}
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
            >
              Edit
            </Link>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() =>
              run(() => deleteInvoice(invoice.id), () => router.push("/ar/invoices"))
            }>
              Delete draft
            </Button>
            <Button size="sm" disabled={pending} onClick={() => run(() => postInvoice(invoice.id))}>
              {pending ? "Posting…" : "Post invoice"}
            </Button>
          </>
        )}
        {invoice.status === "open" && (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setVoidOpen(true)}>
              Void
            </Button>
            <Link
              href={`/ar/payments/new?customerId=${invoice.customerId}&invoiceId=${invoice.id}`}
              className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
            >
              Receive payment
            </Link>
          </>
        )}
      </div>
      {invoice.status !== "voided" && (
        <Link href={`/ar/recurring/new?fromInvoice=${invoice.id}`} className="text-xs text-primary hover:underline">
          Make recurring
        </Link>
      )}
      {err && <p className="text-xs text-destructive max-w-sm text-right">{err}</p>}

      <Dialog open={voidOpen} onOpenChange={setVoidOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void {invoice.invoiceNumber}?</DialogTitle>
            <DialogDescription>
              Posts a reversing journal entry. The invoice stays on record as voided.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVoidOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={pending || !reason.trim()}
              onClick={() => run(() => voidInvoice(invoice.id, reason), () => setVoidOpen(false))}
            >
              Void invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
