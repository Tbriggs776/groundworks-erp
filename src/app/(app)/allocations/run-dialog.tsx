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
import type { Account } from "@/lib/db/schema";
import { runAllocation } from "./actions";

export function RunAllocationDialog({
  open,
  onOpenChange,
  groupId,
  groupName,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupName: string;
  accounts: Account[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [totalAmount, setTotalAmount] = useState("");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [journalDate, setJournalDate] = useState(today);
  const [description, setDescription] = useState("");

  const postingAccounts = accounts.filter(
    (a) => a.accountType === "posting" && a.isActive && !a.isBlocked
  );

  function submit() {
    setErr(null);
    start(async () => {
      const r = await runAllocation({
        groupId,
        totalAmount,
        sourceAccountId,
        journalDate,
        description,
      });
      if (r.ok) {
        onOpenChange(false);
        router.push(`/gl/${r.journalId}`);
      } else {
        setErr(r.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            RUN ALLOCATION
          </DialogTitle>
          <DialogDescription className="text-xs">
            Posts a balanced JE applying <strong>{groupName}</strong>. Debits each
            target; credits the source account for the full total.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Total amount
            </Label>
            <Input
              inputMode="decimal"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
              placeholder="10000.00"
              autoFocus
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Source account (credited for the full total)
            </Label>
            <select
              value={sourceAccountId}
              onChange={(e) => setSourceAccountId(e.target.value)}
              className="w-full text-sm bg-background border border-border rounded-md px-2 py-2"
            >
              <option value="">— choose account —</option>
              {postingAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Journal date
              </Label>
              <Input
                type="date"
                value={journalDate}
                onChange={(e) => setJournalDate(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Description
            </Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Allocate overhead for March"
            />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              pending ||
              !totalAmount ||
              !sourceAccountId ||
              !journalDate ||
              !description.trim()
            }
            onClick={submit}
          >
            {pending ? "Posting…" : "Run allocation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
