"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { formatMoney, money, sumMoney } from "@/lib/money";
import type { Account } from "@/lib/db/schema";
import {
  createRecurring,
  updateRecurring,
  type RecurringInput,
} from "./actions";

type Line = {
  id: string;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
};

type Initial = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  journalDescription: string;
  frequency: RecurringInput["frequency"];
  startDate: string;
  endDate?: string | null;
  nextRunDate: string;
  currency: string;
  status: RecurringInput["status"];
  lines: Array<{
    accountId: string;
    debit: string;
    credit: string;
    memo?: string | null;
  }>;
};

const FREQ_LABEL: Record<RecurringInput["frequency"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannually: "Semi-annually",
  annually: "Annually",
};

function newLine(): Line {
  return {
    id: crypto.randomUUID(),
    accountId: "",
    debit: "",
    credit: "",
    memo: "",
  };
}

function lineFrom(l: Initial["lines"][number]): Line {
  const debit = Number(l.debit) > 0 ? String(l.debit) : "";
  const credit = Number(l.credit) > 0 ? String(l.credit) : "";
  return {
    id: crypto.randomUUID(),
    accountId: l.accountId,
    debit,
    credit,
    memo: l.memo ?? "",
  };
}

export function RecurringForm({
  accounts,
  initial,
}: {
  accounts: Account[];
  initial?: Initial;
}) {
  const router = useRouter();
  const isEdit = !!initial;
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [journalDescription, setJournalDescription] = useState(
    initial?.journalDescription ?? ""
  );
  const [frequency, setFrequency] = useState<RecurringInput["frequency"]>(
    initial?.frequency ?? "monthly"
  );
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(initial?.startDate ?? today);
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [nextRunDate, setNextRunDate] = useState(
    initial?.nextRunDate ?? today
  );
  const [status, setStatus] = useState<RecurringInput["status"]>(
    initial?.status ?? "active"
  );
  const [lines, setLines] = useState<Line[]>(
    initial ? initial.lines.map(lineFrom) : [newLine(), newLine()]
  );

  const totals = useMemo(() => {
    const debits = sumMoney(lines.map((l) => (l.debit ? l.debit : "0")));
    const credits = sumMoney(lines.map((l) => (l.credit ? l.credit : "0")));
    return {
      debits,
      credits,
      diff: debits.minus(credits),
      balanced: debits.equals(credits) && debits.gt(0),
    };
  }, [lines]);

  function updateLine(id: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, newLine()]);
  }
  function removeLine(id: string) {
    setLines((prev) => (prev.length > 2 ? prev.filter((l) => l.id !== id) : prev));
  }

  function submit() {
    setErr(null);
    start(async () => {
      const payload: RecurringInput = {
        code: code.trim(),
        name: name.trim(),
        description: description.trim(),
        journalDescription: journalDescription.trim(),
        frequency,
        startDate,
        endDate: endDate || "",
        nextRunDate,
        currency: "USD",
        status,
        lines: lines
          .filter((l) => l.accountId)
          .map((l) => ({
            accountId: l.accountId,
            debit: l.debit || "",
            credit: l.credit || "",
            memo: l.memo,
          })),
      };
      const r = isEdit
        ? await updateRecurring(initial!.id, payload)
        : await createRecurring(payload);
      if (r.ok) router.push("/recurring");
      else setErr(r.error);
    });
  }

  const postingAccounts = accounts.filter(
    (a) => a.accountType === "posting" && a.isActive && !a.isBlocked
  );

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Code
          </Label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="RENT-MONTHLY"
            autoFocus={!isEdit}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Name
          </Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Monthly rent payment"
          />
        </div>
      </div>

      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Notes / description
        </Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>

      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Journal description (appears on each generated JE)
        </Label>
        <Input
          value={journalDescription}
          onChange={(e) => setJournalDescription(e.target.value)}
          placeholder="Monthly rent payment"
        />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Frequency
          </Label>
          <Select
            value={frequency}
            onValueChange={(v) =>
              setFrequency((v ?? "monthly") as RecurringInput["frequency"])
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(FREQ_LABEL).map(([val, label]) => (
                <SelectItem key={val} value={val}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Start date
          </Label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            End date (optional)
          </Label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Next run
          </Label>
          <Input
            type="date"
            value={nextRunDate}
            onChange={(e) => setNextRunDate(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Status
        </Label>
        <Select
          value={status}
          onValueChange={(v) =>
            setStatus((v ?? "active") as RecurringInput["status"])
          }
        >
          <SelectTrigger className="max-w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="ended">Ended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-8"></th>
              <th className="text-left font-medium px-3 py-2">Account</th>
              <th className="text-right font-medium px-3 py-2 w-32">Debit</th>
              <th className="text-right font-medium px-3 py-2 w-32">Credit</th>
              <th className="text-left font-medium px-3 py-2">Memo</th>
              <th className="text-left font-medium px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => (
              <tr key={line.id} className="border-t border-border">
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                  {idx + 1}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={line.accountId}
                    onChange={(e) =>
                      updateLine(line.id, { accountId: e.target.value })
                    }
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  >
                    <option value="">— choose account —</option>
                    {postingAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={line.debit}
                    onChange={(e) =>
                      updateLine(line.id, {
                        debit: e.target.value,
                        credit: e.target.value ? "" : line.credit,
                      })
                    }
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-right font-mono"
                    placeholder="0.00"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={line.credit}
                    onChange={(e) =>
                      updateLine(line.id, {
                        credit: e.target.value,
                        debit: e.target.value ? "" : line.debit,
                      })
                    }
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-right font-mono"
                    placeholder="0.00"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={line.memo}
                    onChange={(e) => updateLine(line.id, { memo: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => removeLine(line.id)}
                    disabled={lines.length <= 2}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30 border-t-2 border-border">
              <td></td>
              <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Totals
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">
                {formatMoney(totals.debits)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">
                {formatMoney(totals.credits)}
              </td>
              <td className="px-3 py-2">
                {totals.balanced ? (
                  <span className="text-[10px] uppercase tracking-wider text-[var(--gw-green-bright)]">
                    ✓ Balanced
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wider text-[var(--gw-amber-bright)]">
                    Δ {formatMoney(money(totals.diff).abs())}
                  </span>
                )}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div>
        <Button variant="ghost" size="sm" onClick={addLine}>
          <Plus className="h-3.5 w-3.5" />
          Add line
        </Button>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button
          onClick={submit}
          disabled={
            pending ||
            !totals.balanced ||
            !code.trim() ||
            !name.trim() ||
            !journalDescription.trim() ||
            lines.some((l) => !l.accountId)
          }
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create recurring"}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/recurring")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
