"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import { formatMoney, sumMoney } from "@/lib/money";
import type {
  Account,
  Budget,
  BudgetEntry,
  FiscalPeriod,
} from "@/lib/db/schema";
import { addBudgetEntry, deleteBudgetEntry, setBudgetLock } from "../actions";

type EntryWithRefs = BudgetEntry & {
  account: Account;
  period: FiscalPeriod;
};

export function BudgetEditor({
  budget,
  entries,
  accounts,
  periods,
}: {
  budget: Budget;
  entries: EntryWithRefs[];
  accounts: Account[];
  periods: FiscalPeriod[];
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [pending, start] = useTransition();

  const total = sumMoney(entries.map((e) => e.amount));

  function toggleLock() {
    start(async () => {
      const r = await setBudgetLock(budget.id, !budget.isLocked);
      if (!r.ok) alert(r.error);
      router.refresh();
    });
  }

  function removeEntry(id: string) {
    start(async () => {
      const r = await deleteBudgetEntry(id);
      if (!r.ok) alert(r.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-heading text-3xl tracking-[0.1em] text-foreground">
              {budget.name}
            </h1>
            {budget.isLocked ? (
              <Badge variant="destructive" className="text-[9px]">
                Locked
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[9px]">
                Draft
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            <span className="font-mono">{budget.code}</span>
            {budget.description && <span> · {budget.description}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={toggleLock} disabled={pending}>
            {budget.isLocked ? (
              <>
                <LockOpen className="h-3.5 w-3.5" />
                Unlock
              </>
            ) : (
              <>
                <Lock className="h-3.5 w-3.5" />
                Lock budget
              </>
            )}
          </Button>
          <Button
            size="sm"
            onClick={() => setAddOpen(true)}
            disabled={budget.isLocked}
          >
            <Plus className="h-3.5 w-3.5" />
            Add entry
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-28">Period</th>
              <th className="text-left font-medium px-3 py-2">Account</th>
              <th className="text-left font-medium px-3 py-2">Memo</th>
              <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              <th className="text-right font-medium px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-xs text-muted-foreground"
                >
                  No entries yet.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {e.period.periodCode}
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs text-primary">
                    {e.account.code}
                  </span>{" "}
                  <span>{e.account.name}</span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {e.memo}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(e.amount)}
                </td>
                <td className="px-3 py-2 text-right">
                  {!budget.isLocked && (
                    <button
                      onClick={() => removeEntry(e.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30 border-t-2 border-border">
              <td></td>
              <td
                className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                colSpan={2}
              >
                Total ({entries.length} entries)
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">
                {formatMoney(total)}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <AddEntryDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        budgetId={budget.id}
        accounts={accounts}
        periods={periods}
      />
    </div>
  );
}

function AddEntryDialog({
  open,
  onOpenChange,
  budgetId,
  accounts,
  periods,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budgetId: string;
  accounts: Account[];
  periods: FiscalPeriod[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [periodId, setPeriodId] = useState(periods[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const postingAccounts = accounts.filter(
    (a) => a.accountType === "posting" && a.isActive && !a.isBlocked
  );

  function submit() {
    setErr(null);
    start(async () => {
      const r = await addBudgetEntry({
        budgetId,
        accountId,
        periodId,
        amount,
        memo: memo || undefined,
      });
      if (r.ok) {
        setAccountId("");
        setAmount("");
        setMemo("");
        onOpenChange(false);
        router.refresh();
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
            ADD BUDGET ENTRY
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Period
            </Label>
            <Select value={periodId} onValueChange={(v) => setPeriodId(v ?? "")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.periodCode} ({p.startDate} — {p.endDate})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Account
            </Label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
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
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Amount
            </Label>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="font-mono text-right"
              autoFocus
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Memo (optional)
            </Label>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || !accountId || !periodId || !amount}
            onClick={submit}
          >
            {pending ? "Adding…" : "Add entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
