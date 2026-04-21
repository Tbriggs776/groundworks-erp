"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { formatMoney, money, sumMoney } from "@/lib/money";
import type { Account, ReasonCode, SourceCode } from "@/lib/db/schema";
import { postManualJournal } from "./actions";

type Line = {
  id: string;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
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

export function JournalEntryForm({
  accounts,
  sourceCodes,
  reasonCodes,
  defaultSourceCodeId,
}: {
  accounts: Account[];
  sourceCodes: SourceCode[];
  reasonCodes: ReasonCode[];
  defaultSourceCodeId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [journalDate, setJournalDate] = useState(today);
  const [sourceCodeId, setSourceCodeId] = useState(defaultSourceCodeId);
  const [reasonCodeId, setReasonCodeId] = useState<string | "">("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine(), newLine()]);

  const totals = useMemo(() => {
    const debits = sumMoney(lines.map((l) => (l.debit ? l.debit : "0")));
    const credits = sumMoney(lines.map((l) => (l.credit ? l.credit : "0")));
    const diff = debits.minus(credits);
    return {
      debits,
      credits,
      diff,
      balanced: diff.equals(0) && debits.gt(0),
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
    setError(null);
    start(async () => {
      const r = await postManualJournal({
        journalDate,
        sourceCodeId,
        reasonCodeId: reasonCodeId || null,
        description,
        currency: "USD",
        lines: lines
          .filter((l) => l.accountId)
          .map((l) => ({
            accountId: l.accountId,
            debit: l.debit || "",
            credit: l.credit || "",
            memo: l.memo || "",
          })),
      });
      if (r.ok) {
        router.push(`/gl/${r.journalId}`);
      } else {
        setError(r.error);
      }
    });
  }

  const postingAccounts = accounts.filter(
    (a) => a.accountType === "posting" && a.isActive && !a.isBlocked
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 max-w-2xl">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Date
          </Label>
          <Input
            type="date"
            value={journalDate}
            onChange={(e) => setJournalDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Source
          </Label>
          <Select
            value={sourceCodeId}
            onValueChange={(v) => setSourceCodeId(v ?? "")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sourceCodes.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.code} — {s.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="max-w-2xl">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Description
        </Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. March rent payment"
        />
      </div>

      {reasonCodes.length > 0 && (
        <div className="max-w-2xl">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Reason (optional)
          </Label>
          <Select
            value={reasonCodeId}
            onValueChange={(v) =>
              setReasonCodeId(v === "__none__" || v == null ? "" : v)
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">—</SelectItem>
              {reasonCodes.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.code} — {r.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

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
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
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

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={addLine}>
          <Plus className="h-3.5 w-3.5" />
          Add line
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button
          onClick={submit}
          disabled={
            pending ||
            !totals.balanced ||
            !description.trim() ||
            lines.some((l) => !l.accountId)
          }
        >
          {pending ? "Posting…" : "Post journal"}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/gl")}>
          Cancel
        </Button>
        {!totals.balanced && (
          <span className="text-xs text-muted-foreground">
            Fill lines so debits equal credits.
          </span>
        )}
      </div>
    </div>
  );
}
