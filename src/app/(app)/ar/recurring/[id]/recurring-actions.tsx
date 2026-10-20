"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteRecurringInvoice, invoiceFromTemplate, setRecurringStatus } from "../actions";

/** Use now, pause / resume, edit, delete. */
export function RecurringActions({ template }: { template: { id: string; name: string; status: string; type: string } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [useOpen, setUseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState(format(new Date(), "yyyy-MM-dd"));

  function run(fn: () => Promise<{ ok: boolean; error?: string; id?: string }>, after?: (id?: string) => void) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.(r.id);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Link
          href={`/ar/recurring/${template.id}/edit`}
          className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
        >
          Edit
        </Link>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDeleteOpen(true)}>
          Delete
        </Button>
        {template.type !== "unscheduled" && template.status === "active" && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setRecurringStatus(template.id, "paused"))}>
            Pause
          </Button>
        )}
        {template.type !== "unscheduled" && template.status === "paused" && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setRecurringStatus(template.id, "active"))}>
            Resume
          </Button>
        )}
        <Button size="sm" disabled={pending} onClick={() => setUseOpen(true)}>
          Create invoice now
        </Button>
      </div>
      {err && <p className="text-xs text-destructive max-w-sm text-right">{err}</p>}

      <Dialog open={useOpen} onOpenChange={setUseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an invoice from {template.name}?</DialogTitle>
            <DialogDescription>Makes a draft invoice now. The schedule doesn&apos;t change.</DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Invoice date</Label>
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUseOpen(false)}>Cancel</Button>
            <Button
              disabled={pending || !invoiceDate}
              onClick={() =>
                run(
                  () => invoiceFromTemplate(template.id, invoiceDate),
                  (id) => {
                    setUseOpen(false);
                    if (id) router.push(`/ar/invoices/${id}`);
                  }
                )
              }
            >
              Create draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {template.name}?</DialogTitle>
            <DialogDescription>Stops the schedule for good. Invoices it already made stay as they are.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => deleteRecurringInvoice(template.id), () => router.push("/ar/recurring"))}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
