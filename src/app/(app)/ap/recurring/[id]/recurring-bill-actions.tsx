"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { billFromTemplate, deleteRecurringBill, setRecurringBillStatus } from "../actions";

/** Use now, pause / resume, edit, delete. */
export function RecurringBillActions({ template }: { template: { id: string; name: string; status: string; type: string } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [useOpen, setUseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [billDate, setBillDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [submit, setSubmit] = useState(false);

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
          href={`/ap/recurring/${template.id}/edit`}
          className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
        >
          Edit
        </Link>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDeleteOpen(true)}>
          Delete
        </Button>
        {template.type !== "unscheduled" && template.status === "active" && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setRecurringBillStatus(template.id, "paused"))}>
            Pause
          </Button>
        )}
        {template.type !== "unscheduled" && template.status === "paused" && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setRecurringBillStatus(template.id, "active"))}>
            Resume
          </Button>
        )}
        <Button size="sm" disabled={pending} onClick={() => setUseOpen(true)}>
          Create bill now
        </Button>
      </div>
      {err && <p className="text-xs text-destructive max-w-sm text-right">{err}</p>}

      <Dialog open={useOpen} onOpenChange={setUseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a bill from {template.name}?</DialogTitle>
            <DialogDescription>Makes a bill now. The schedule doesn&apos;t change.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Bill date</Label>
              <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} aria-label="Bill date" />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--primary)]" />
              Submit it for approval
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUseOpen(false)}>Cancel</Button>
            <Button
              disabled={pending || !billDate}
              onClick={() =>
                run(
                  () => billFromTemplate(template.id, billDate, submit),
                  (id) => {
                    setUseOpen(false);
                    if (id) router.push(`/ap/bills/${id}`);
                  }
                )
              }
            >
              Create bill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {template.name}?</DialogTitle>
            <DialogDescription>Stops the schedule for good. Bills it already made stay as they are.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => deleteRecurringBill(template.id), () => router.push("/ap/recurring"))}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
