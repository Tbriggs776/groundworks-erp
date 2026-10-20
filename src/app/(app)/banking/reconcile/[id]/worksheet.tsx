"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReconciliationWorksheet } from "@/lib/banking/reconcile";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { cancelReconciliation, completeReconciliation, setCleared, undoReconciliation, updateStatementBalance } from "../../actions";

type Filter = "all" | "decrease" | "increase";

export function Worksheet({ sheet, currency, canEdit }: { sheet: ReconciliationWorksheet; currency: string; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cleared, setClearedIds] = useState<Set<string>>(() => new Set(sheet.lines.filter((l) => l.cleared).map((l) => l.glLineId)));
  const [filter, setFilter] = useState<Filter>("all");
  const [err, setErr] = useState<string | null>(null);
  const [endDate, setEndDate] = useState(sheet.statementEndDate);
  const [ending, setEnding] = useState(money(sheet.statementEndingBalance).toFixed(2));
  const card = sheet.normalBalance === "credit";
  const fmt = (v: string) => formatMoney(v, { currency });

  const totals = useMemo(() => {
    const ticked = sheet.lines.filter((l) => cleared.has(l.glLineId)).map((l) => money(l.amount));
    const increase = sumMoney(ticked.filter((a) => a.gt(0)));
    const decrease = sumMoney(ticked.filter((a) => a.lt(0))).abs();
    const balance = money(sheet.beginningBalance).plus(increase).minus(decrease);
    return { increase, decrease, balance, difference: money(sheet.statementEndingBalance).minus(balance) };
  }, [cleared, sheet]);

  const shown = sheet.lines.filter((l) => (filter === "all" ? true : filter === "increase" ? money(l.amount).gt(0) : money(l.amount).lt(0)));
  const allShownTicked = shown.length > 0 && shown.every((l) => cleared.has(l.glLineId));

  function toggle(ids: string[], on: boolean) {
    if (!canEdit || ids.length === 0) return;
    const before = new Set(cleared);
    setClearedIds((s) => {
      const n = new Set(s);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
    setErr(null);
    start(async () => {
      const r = await setCleared(sheet.id, ids, on);
      if (!r.ok) {
        setClearedIds(before);
        setErr(r.error);
      }
    });
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after: () => void) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else after();
    });
  }

  const statementChanged = endDate !== sheet.statementEndDate || !money(ending || "0").eq(money(sheet.statementEndingBalance));
  const balanced = totals.difference.isZero();

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Statement ending date</Label>
            <Input type="date" value={endDate} disabled={!canEdit} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{card ? "Ending balance owed" : "Ending balance"}</Label>
            <Input inputMode="decimal" value={ending} disabled={!canEdit} onChange={(e) => setEnding(e.target.value)} className="w-36 font-mono text-right" />
          </div>
          {statementChanged && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => updateStatementBalance(sheet.id, ending, endDate), () => router.refresh())}>
              Update
            </Button>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Difference</div>
          <div className={cn("font-mono text-3xl", balanced ? "text-primary" : "text-destructive")}>{fmt(totals.difference.toFixed(4))}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
        <Figure label="Beginning balance" value={fmt(sheet.beginningBalance)} />
        <Figure label={card ? "Charges cleared" : "Deposits cleared"} value={`+ ${fmt(totals.increase.toFixed(4))}`} />
        <Figure label="Payments cleared" value={`− ${fmt(totals.decrease.toFixed(4))}`} />
        <Figure label="Cleared balance" value={fmt(totals.balance.toFixed(4))} />
        <Figure label="Statement says" value={fmt(sheet.statementEndingBalance)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 text-xs">
          {(
            [
              ["all", "All"],
              ["decrease", "Payments"],
              ["increase", card ? "Charges" : "Deposits"],
            ] as const
          ).map(([f, label]) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn("rounded-md px-2.5 py-1", filter === f ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {label}
            </button>
          ))}
        </div>
        {err && <p className="text-xs text-destructive">{err}</p>}
      </div>

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 w-8">
                <Checkbox
                  aria-label="Tick all shown"
                  checked={allShownTicked}
                  disabled={!canEdit}
                  onCheckedChange={() => toggle(shown.map((l) => l.glLineId), !allShownTicked)}
                />
              </th>
              <th className="text-left font-medium px-3 py-2 w-28">Date</th>
              <th className="text-left font-medium px-3 py-2 w-32">Ref</th>
              <th className="text-left font-medium px-3 py-2">Payee / memo</th>
              <th className="text-right font-medium px-3 py-2 w-32">Payment</th>
              <th className="text-right font-medium px-3 py-2 w-32">{card ? "Charge" : "Deposit"}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                  Nothing on or before {sheet.statementEndDate} waiting to be reconciled.
                </td>
              </tr>
            )}
            {shown.map((l) => {
              const amt = money(l.amount);
              const on = cleared.has(l.glLineId);
              return (
                <tr
                  key={l.glLineId}
                  className={cn("border-t border-border cursor-pointer", on && "bg-primary/5")}
                  onClick={() => toggle([l.glLineId], !on)}
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <Checkbox aria-label="Cleared" checked={on} disabled={!canEdit} onCheckedChange={() => toggle([l.glLineId], !on)} />
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{l.date}</td>
                  <td className="px-3 py-2 text-xs font-mono">{l.journalNumber}</td>
                  <td className="px-3 py-2">
                    <div>{l.payee ?? l.description}</div>
                    {l.payee && <div className="text-[11px] text-muted-foreground">{l.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{amt.lt(0) ? fmt(amt.abs().toFixed(4)) : ""}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{amt.gt(0) ? fmt(l.amount) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground mr-auto">
            Ticks save as you go. Leave and come back any time; cancelling keeps them for next time.
          </span>
          <Button variant="ghost" disabled={pending} onClick={() => run(() => cancelReconciliation(sheet.id), () => router.push("/banking/reconcile"))}>
            Cancel reconciliation
          </Button>
          <Button disabled={pending || !balanced || statementChanged} onClick={() => run(() => completeReconciliation(sheet.id), () => router.refresh())}>
            Finish now
          </Button>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono mt-0.5">{value}</div>
    </div>
  );
}

export function UndoReconciliation({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Undo reconciliation
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo this reconciliation?</DialogTitle>
            <DialogDescription>
              Its items go back to cleared so the statement can be reconciled again. Only the most recent reconciliation of an account can be undone.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ticked the wrong check" autoFocus />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={pending || !reason.trim()}
              onClick={() =>
                start(async () => {
                  const r = await undoReconciliation(id, reason);
                  if (!r.ok) setErr(r.error);
                  else {
                    setOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              Undo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
