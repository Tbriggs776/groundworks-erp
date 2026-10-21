"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Paperclip, Plus, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MatchCandidate, StatementLineRow } from "@/lib/banking/review";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { addLine, applyRules, excludeLine, findMatches, matchLine, undoLine } from "../actions";
import type { BankingChoices } from "../choices";
import { accountOption, Picker } from "../picker";

type Result = { ok: boolean; error?: string };

export function ApplyRulesButton({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await applyRules(accountId);
            if (!r.ok) setMsg(r.error);
            else {
              setMsg(`Recorded ${r.result.autoAdded}, suggested ${r.result.categorized}.`);
              router.refresh();
            }
          })
        }
      >
        <Wand2 className="h-3.5 w-3.5" /> Run rules
      </Button>
    </div>
  );
}

export function ReviewLines({
  lines,
  status,
  accountId,
  currency,
  choices,
}: {
  lines: StatementLineRow[];
  status: "for_review" | "matched" | "added" | "excluded";
  accountId: string;
  currency: string;
  choices: BankingChoices;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fmt = (v: string) => formatMoney(v, { currency });

  function act(lineId: string, fn: () => Promise<Result>, after?: () => void) {
    setBusy(lineId);
    setErrors((e) => ({ ...e, [lineId]: "" }));
    start(async () => {
      const r = await fn();
      if (!r.ok) setErrors((e) => ({ ...e, [lineId]: r.error ?? "Failed." }));
      else after?.();
      setBusy(null);
      router.refresh();
    });
  }

  /** Accept what's suggested: the best match, else the rule. */
  const accept = (l: StatementLineRow) =>
    l.suggestedMatches[0] ? matchLine(l.id, [l.suggestedMatches[0].glLineId]) : addLine({ id: l.id });
  const acceptable = (l: StatementLineRow) => l.suggestedMatches.length > 0 || !!l.suggestedRule;

  function batch(kind: "accept" | "exclude") {
    const targets = lines.filter((l) => selected.has(l.id) && (kind === "exclude" || acceptable(l)));
    setBusy("batch");
    start(async () => {
      const errs: Record<string, string> = {};
      for (const l of targets) {
        const r = kind === "accept" ? await accept(l) : await excludeLine(l.id);
        if (!r.ok) errs[l.id] = r.error;
      }
      setErrors(errs);
      setSelected(new Set());
      setBusy(null);
      router.refresh();
    });
  }

  if (lines.length === 0) {
    return (
      <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
        {status === "for_review" ? "All caught up. Import a statement to bring in new lines." : "Nothing here."}
      </div>
    );
  }

  const reviewing = status === "for_review";
  const allSelected = selected.size === lines.length;

  return (
    <div className="space-y-2">
      {reviewing && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{selected.size > 0 ? `${selected.size} selected` : "Select lines to act on several at once."}</span>
          {selected.size > 0 && (
            <>
              <Button size="xs" disabled={pending} onClick={() => batch("accept")}>Accept suggested</Button>
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => batch("exclude")}>Exclude</Button>
            </>
          )}
        </div>
      )}
      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {reviewing && (
                <th className="px-3 py-2 w-8">
                  <Checkbox
                    aria-label="Select all"
                    checked={allSelected}
                    onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(lines.map((l) => l.id)))}
                  />
                </th>
              )}
              <th className="text-left font-medium px-3 py-2 w-28">Date</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-right font-medium px-3 py-2 w-28">Spent</th>
              <th className="text-right font-medium px-3 py-2 w-28">Received</th>
              <th className="text-left font-medium px-3 py-2">{reviewing ? "Suggested" : "Recorded as"}</th>
              <th className="w-40"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const amt = money(l.amount);
              const isOpen = open === l.id;
              const top = l.suggestedMatches[0];
              return (
                <Fragment key={l.id}>
                  <tr className={cn("border-t border-border align-top", isOpen && "bg-muted/30")}>
                    {reviewing && (
                      <td className="px-3 py-2">
                        <Checkbox
                          aria-label="Select line"
                          checked={selected.has(l.id)}
                          onCheckedChange={() =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (n.has(l.id)) n.delete(l.id);
                              else n.add(l.id);
                              return n;
                            })
                          }
                        />
                      </td>
                    )}
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{l.postedDate}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="flex items-start gap-1 text-left"
                        onClick={() => reviewing && setOpen(isOpen ? null : l.id)}
                      >
                        {reviewing &&
                          (isOpen ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />)}
                        <span>
                          <span className="block">{l.payee ?? l.description}</span>
                          {l.payee && l.payee !== l.description && <span className="block text-[11px] text-muted-foreground">{l.description}</span>}
                          {l.reference && <span className="block text-[11px] text-muted-foreground">Ref {l.reference}</span>}
                        </span>
                      </button>
                      {l.attachments.map((f) => (
                        <a
                          key={f.id}
                          href={f.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-0.5 flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <Paperclip className="h-3 w-3" /> {f.fileName}
                        </a>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{amt.lt(0) ? fmt(amt.abs().toFixed(4)) : ""}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{amt.gt(0) ? fmt(l.amount) : ""}</td>
                    <td className="px-3 py-2 text-xs">
                      {reviewing ? (
                        top ? (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <Sparkles className="h-3 w-3" /> Match {top.journalNumber} · {top.date}
                            {l.suggestedMatches.length > 1 && <span className="text-muted-foreground"> (+{l.suggestedMatches.length - 1})</span>}
                          </span>
                        ) : l.suggestedRule ? (
                          <span className="inline-flex items-center gap-1">
                            <Wand2 className="h-3 w-3" /> Rule: {l.suggestedRule.name}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Uncategorized</span>
                        )
                      ) : l.bankTransactionId ? (
                        <Link href={`/banking/transactions/${l.bankTransactionId}`} className="text-primary hover:underline">
                          View transaction
                        </Link>
                      ) : (
                        <span className="capitalize text-muted-foreground">{l.status.replace("_", " ")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {reviewing ? (
                        acceptable(l) ? (
                          <Button size="xs" disabled={pending && busy === l.id} onClick={() => act(l.id, () => accept(l))}>
                            {top ? "Match" : "Add"}
                          </Button>
                        ) : (
                          <Button size="xs" variant="outline" onClick={() => setOpen(isOpen ? null : l.id)}>
                            Categorize
                          </Button>
                        )
                      ) : (
                        <Button size="xs" variant="ghost" disabled={pending && busy === l.id} onClick={() => act(l.id, () => undoLine(l.id))}>
                          Undo
                        </Button>
                      )}
                      {errors[l.id] && <div className="text-[11px] text-destructive mt-1 max-w-xs ml-auto text-right">{errors[l.id]}</div>}
                    </td>
                  </tr>
                  {isOpen && reviewing && (
                    <tr className="bg-muted/30">
                      <td colSpan={7} className="px-3 pb-4 pt-1">
                        <LineDetail
                          line={l}
                          accountId={accountId}
                          currency={currency}
                          choices={choices}
                          pending={pending && busy === l.id}
                          onAct={(fn) => act(l.id, fn, () => setOpen(null))}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LineDetail({
  line,
  accountId,
  currency,
  choices,
  pending,
  onAct,
}: {
  line: StatementLineRow;
  accountId: string;
  currency: string;
  choices: BankingChoices;
  pending: boolean;
  onAct: (fn: () => Promise<Result>) => void;
}) {
  const moneyIn = money(line.amount).gt(0);
  const [mode, setMode] = useState<"add" | "match">(line.suggestedMatches.length > 0 ? "match" : "add");
  const [kind, setKind] = useState<"category" | "transfer">("category");
  const [categoryId, setCategoryId] = useState("");
  const [transferId, setTransferId] = useState("");
  const [payee, setPayee] = useState("");
  const [payeeName, setPayeeName] = useState(line.payee ?? "");
  const [memo, setMemo] = useState("");
  const [split, setSplit] = useState(false);
  const [rows, setRows] = useState<Array<{ accountId: string; amount: string }>>([
    { accountId: "", amount: money(line.amount).abs().toFixed(2) },
    { accountId: "", amount: "" },
  ]);
  const [candidates, setCandidates] = useState<MatchCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(line.suggestedMatches[0] ? [line.suggestedMatches[0].glLineId] : []));
  const fmt = (v: string) => formatMoney(v, { currency });

  const payeeOptions = useMemo(
    () => [
      ...choices.vendors.map((v) => ({ value: `v:${v.id}`, label: `${v.name} (vendor)` })),
      ...choices.customers.map((c) => ({ value: `c:${c.id}`, label: `${c.name} (customer)` })),
    ],
    [choices]
  );

  async function loadCandidates() {
    setMode("match");
    if (candidates) return;
    setLoading(true);
    const r = await findMatches(line.id);
    setCandidates(r.ok ? r.candidates : []);
    setLoading(false);
  }

  const list = candidates ?? line.suggestedMatches;
  const pickedTotal = sumMoney(list.filter((c) => picked.has(c.glLineId)).map((c) => c.amount));
  const balanced = picked.size > 0 && pickedTotal.eq(money(line.amount));

  const splitting = kind === "category" && split;
  const filled = rows.filter((r) => r.accountId || r.amount);
  const splitTotal = sumMoney(filled.map((r) => (/^\d+(\.\d+)?$/.test(r.amount) ? r.amount : "0")));
  const left = money(line.amount).abs().minus(splitTotal);
  const splitReady = filled.length >= 2 && filled.every((r) => r.accountId && /^\d+(\.\d+)?$/.test(r.amount) && money(r.amount).gt(0)) && left.isZero();
  const setRow = (i: number, patch: Partial<{ accountId: string; amount: string }>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function add() {
    onAct(() =>
      addLine({
        id: line.id,
        splits: splitting ? filled.map((r) => ({ accountId: r.accountId, amount: r.amount })) : undefined,
        categoryAccountId: kind === "category" && !splitting ? categoryId || undefined : undefined,
        transferAccountId: kind === "transfer" ? transferId || undefined : undefined,
        vendorId: payee.startsWith("v:") ? payee.slice(2) : undefined,
        customerId: payee.startsWith("c:") ? payee.slice(2) : undefined,
        payeeName: payeeName || undefined,
        memo: memo || undefined,
      })
    );
  }

  const canAdd = splitting ? splitReady : kind === "category" ? !!categoryId || !!line.suggestedRule : !!transferId;

  return (
    <div className="rounded-md border border-border bg-background p-3 space-y-3">
      <div className="flex gap-1 text-xs">
        <button
          type="button"
          onClick={() => setMode("add")}
          className={cn("rounded-md px-2.5 py-1", mode === "add" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
        >
          Add as new
        </button>
        <button
          type="button"
          onClick={loadCandidates}
          className={cn("rounded-md px-2.5 py-1", mode === "match" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
        >
          Match to the books
        </button>
      </div>

      {mode === "add" ? (
        <div className="space-y-3">
          <div className="flex gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={kind === "category"} onChange={() => setKind("category")} />
              {moneyIn ? "Deposit" : "Expense"}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={kind === "transfer"} onChange={() => setKind("transfer")} />
              Transfer {moneyIn ? "from" : "to"} another account
            </label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {splitting ? null : kind === "category" ? (
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Category</Label>
                <Picker
                  ariaLabel="Category"
                  options={choices.categories.filter((c) => c.id !== accountId).map(accountOption)}
                  value={categoryId}
                  onChange={setCategoryId}
                  placeholder={line.suggestedRule ? `From rule: ${line.suggestedRule.name}` : "Choose category…"}
                />
              </div>
            ) : (
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Other account</Label>
                <Picker
                  ariaLabel="Transfer account"
                  options={choices.bankAccounts.filter((a) => a.id !== accountId).map(accountOption)}
                  value={transferId}
                  onChange={setTransferId}
                  placeholder="Choose account…"
                />
              </div>
            )}
            {kind === "category" && (
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{moneyIn ? "Received from" : "Payee"}</Label>
                <Picker ariaLabel="Payee" options={payeeOptions} value={payee} onChange={setPayee} placeholder="Optional" />
              </div>
            )}
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{kind === "category" ? "Or a name" : "Memo"}</Label>
              {kind === "category" ? (
                <Input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Payee name" />
              ) : (
                <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
              )}
            </div>
          </div>
          {kind === "category" && (
            <div className="space-y-2">
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setSplit((v) => !v)}>
                {split ? "Use one category" : "Split across categories"}
              </button>
              {split && (
                <div className="space-y-2 max-w-2xl">
                  {rows.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="flex-1">
                        <Picker
                          ariaLabel={`Split ${i + 1} category`}
                          options={choices.categories.filter((c) => c.id !== accountId).map(accountOption)}
                          value={r.accountId}
                          onChange={(v) => setRow(i, { accountId: v })}
                          placeholder="Choose category…"
                        />
                      </div>
                      <Input
                        className="w-32 text-right font-mono"
                        inputMode="decimal"
                        aria-label={`Split ${i + 1} amount`}
                        value={r.amount}
                        onChange={(e) => setRow(i, { amount: e.target.value.replace(/[^0-9.]/g, "") })}
                        placeholder="0.00"
                      />
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Remove split"
                        disabled={rows.length <= 2}
                        onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-xs">
                    <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => setRows((rs) => [...rs, { accountId: "", amount: "" }])}>
                      <Plus className="h-3 w-3" /> Add a split
                    </button>
                    <span className={cn(left.isZero() ? "text-primary" : "text-muted-foreground")}>
                      {left.isZero() ? "Splits add up" : `${fmt(left.abs().toFixed(4))} ${left.gt(0) ? "left to split" : "over"}`}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          {kind === "category" && (
            <div className="max-w-xl">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Memo</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAct(() => excludeLine(line.id))}>
              Exclude
            </Button>
            <Button size="sm" disabled={pending || !canAdd} onClick={add}>
              Add {fmt(money(line.amount).abs().toFixed(4))}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Pick what this line pays or deposits. Several entries can add up to one line (e.g. a deposit of several checks).
          </p>
          {loading && <p className="text-xs text-muted-foreground">Looking…</p>}
          {!loading && list.length === 0 && <p className="text-xs text-muted-foreground">Nothing unmatched in the books near this date.</p>}
          {list.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <tbody>
                  {list.map((c) => (
                    <tr key={c.glLineId} className="border-t border-border first:border-t-0">
                      <td className="px-2 py-1.5 w-8">
                        <Checkbox
                          aria-label="Pick"
                          checked={picked.has(c.glLineId)}
                          onCheckedChange={() =>
                            setPicked((s) => {
                              const n = new Set(s);
                              if (n.has(c.glLineId)) n.delete(c.glLineId);
                              else n.add(c.glLineId);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-muted-foreground w-24">{c.date}</td>
                      <td className="px-2 py-1.5 font-mono w-28">{c.journalNumber}</td>
                      <td className="px-2 py-1.5">{c.description}</td>
                      <td className="px-2 py-1.5 text-right font-mono w-28">{fmt(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn("text-xs", balanced ? "text-primary" : "text-muted-foreground")}>
              Picked {fmt(pickedTotal.toFixed(4))} of {fmt(line.amount)}
            </span>
            <div className="flex gap-2">
              {!candidates && (
                <Button size="sm" variant="ghost" onClick={loadCandidates}>
                  Show everything nearby
                </Button>
              )}
              <Button size="sm" disabled={pending || !balanced} onClick={() => onAct(() => matchLine(line.id, [...picked]))}>
                Match
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
