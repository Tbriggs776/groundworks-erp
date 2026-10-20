"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { QueuedCheck } from "@/lib/ap/checks";
import { formatMoney, sumMoney } from "@/lib/money";
import { printQueuedChecks } from "../../ap/ap-actions";

const href = (c: { kind: string; id: string }) => (c.kind === "bill_payment" ? `/ap/payments/${c.id}` : `/banking/transactions/${c.id}`);

/** Pick queued checks, number them from the first check in the printer, then open the PDF. */
export function PrintChecksClient({
  bankAccountId,
  nextCheckNumber,
  checks,
  canPrint,
}: {
  bankAccountId: string;
  nextCheckNumber: number;
  checks: QueuedCheck[];
  canPrint: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(checks.map((c) => c.id)));
  const [first, setFirst] = useState(String(nextCheckNumber));
  const [err, setErr] = useState<string | null>(null);
  const [printed, setPrinted] = useState<{ pdf: string; from: string; to: string; count: number } | null>(null);

  const chosen = checks.filter((c) => picked.has(c.id));
  const firstNumber = Number(first);
  const validFirst = Number.isInteger(firstNumber) && firstNumber >= 1;

  function toggle(id: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  }

  function print() {
    setErr(null);
    start(async () => {
      const r = await printQueuedChecks({ bankAccountId, firstCheckNumber: firstNumber, checks: chosen.map((c) => ({ kind: c.kind, id: c.id })) });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      const items = r.printed.map((p) => `${p.kind}:${p.id}`).join(",");
      setPrinted({
        pdf: `/pdf/checks?items=${items}`,
        from: r.printed[0].checkNumber,
        to: r.printed[r.printed.length - 1].checkNumber,
        count: r.printed.length,
      });
      setFirst(String(r.nextCheckNumber));
      setPicked(new Set());
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {printed && (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-3">
          <span>
            Numbered {printed.count} check{printed.count === 1 ? "" : "s"}: {printed.from}
            {printed.count > 1 ? ` to ${printed.to}` : ""}. Open the PDF and print it on your check stock.
          </span>
          <a
            href={printed.pdf}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Printer className="h-3.5 w-3.5" /> Open checks PDF
          </a>
        </div>
      )}
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 w-10">
                <Checkbox
                  aria-label="Select all"
                  checked={checks.length > 0 && picked.size === checks.length}
                  onCheckedChange={(v) => setPicked(v ? new Set(checks.map((c) => c.id)) : new Set())}
                />
              </th>
              <th className="text-left font-medium px-3 py-2 w-28">Date</th>
              <th className="text-left font-medium px-3 py-2 w-28">Number</th>
              <th className="text-left font-medium px-3 py-2">Payee</th>
              <th className="text-right font-medium px-3 py-2 w-36">Amount</th>
            </tr>
          </thead>
          <tbody>
            {checks.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-10 text-center text-xs text-muted-foreground">No checks waiting to print on this account.</td></tr>
            )}
            {checks.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <Checkbox aria-label={`Print ${c.documentNumber}`} checked={picked.has(c.id)} onCheckedChange={(v) => toggle(c.id, Boolean(v))} />
                </td>
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{c.date}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  <Link href={href(c)} className="text-primary hover:underline">{c.documentNumber}</Link>
                </td>
                <td className="px-3 py-2">{c.payee}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(c.amount, { currency: c.currency })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {checks.length > 0 && canPrint && (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Label htmlFor="first-check" className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">First check number</Label>
            <Input id="first-check" className="w-40 font-mono" inputMode="numeric" value={first} onChange={(e) => setFirst(e.target.value.trim())} />
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">
              {chosen.length} selected · {formatMoney(sumMoney(chosen.map((c) => c.amount)), { currency: chosen[0]?.currency ?? checks[0].currency })}
            </span>
            <Button disabled={pending || chosen.length === 0 || !validFirst} onClick={print}>
              <Printer className="h-4 w-4" /> Print {chosen.length || ""} check{chosen.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
