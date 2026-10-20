"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BankRule, BankRuleCondition } from "@/lib/db/schema";
import { applyRules, createRule, deleteRule, updateRule } from "../actions";
import type { BankingChoices } from "../choices";
import { accountOption, Picker } from "../picker";

const FIELDS = [
  { value: "description", label: "Description" },
  { value: "payee", label: "Payee" },
  { value: "amount", label: "Amount" },
];
const TEXT_OPS = [
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "equals", label: "is exactly" },
  { value: "starts_with", label: "starts with" },
];
const AMOUNT_OPS = [
  { value: "equals", label: "equals" },
  { value: "greater_than", label: "is more than" },
  { value: "less_than", label: "is less than" },
];
const DIRECTIONS = [
  { value: "any", label: "Money in or out" },
  { value: "money_out", label: "Money out" },
  { value: "money_in", label: "Money in" },
];

type Draft = {
  id?: string;
  name: string;
  priority: string;
  accountId: string;
  direction: string;
  matchAll: boolean;
  conditions: BankRuleCondition[];
  kind: "category" | "transfer";
  categoryAccountId: string;
  transferAccountId: string;
  payee: string;
  memo: string;
  autoAdd: boolean;
};

const blank = (): Draft => ({
  name: "",
  priority: "100",
  accountId: "",
  direction: "any",
  matchAll: true,
  conditions: [{ field: "description", op: "contains", value: "" }],
  kind: "category",
  categoryAccountId: "",
  transferAccountId: "",
  payee: "",
  memo: "",
  autoAdd: false,
});

const fromRule = (r: BankRule): Draft => ({
  id: r.id,
  name: r.name,
  priority: String(r.priority),
  accountId: r.accountId ?? "",
  direction: r.direction,
  matchAll: r.matchAll,
  conditions: r.conditions,
  kind: r.transferAccountId ? "transfer" : "category",
  categoryAccountId: r.categoryAccountId ?? "",
  transferAccountId: r.transferAccountId ?? "",
  payee: r.vendorId ? `v:${r.vendorId}` : r.customerId ? `c:${r.customerId}` : "",
  memo: r.memo ?? "",
  autoAdd: r.autoAdd,
});

export function RulesClient({ rules, choices, canEdit }: { rules: BankRule[]; choices: BankingChoices; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const name = (list: Array<{ id: string; code?: string; name: string }>, id: string | null) => {
    const a = list.find((x) => x.id === id);
    return a ? accountOption(a).label : "—";
  };
  const payeeOptions = [
    ...choices.vendors.map((v) => ({ value: `v:${v.id}`, label: `${v.name} (vendor)` })),
    ...choices.customers.map((c) => ({ value: `c:${c.id}`, label: `${c.name} (customer)` })),
  ];

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

  function save() {
    if (!draft) return;
    const input = {
      name: draft.name,
      priority: Number(draft.priority) || 100,
      accountId: draft.accountId || null,
      direction: draft.direction as "any",
      matchAll: draft.matchAll,
      conditions: draft.conditions.filter((c) => c.value.trim()),
      categoryAccountId: draft.kind === "category" ? draft.categoryAccountId || null : null,
      transferAccountId: draft.kind === "transfer" ? draft.transferAccountId || null : null,
      vendorId: draft.payee.startsWith("v:") ? draft.payee.slice(2) : null,
      customerId: draft.payee.startsWith("c:") ? draft.payee.slice(2) : null,
      memo: draft.memo || undefined,
      autoAdd: draft.autoAdd,
    };
    run(() => (draft.id ? updateRule({ id: draft.id, ...input }) : createRule(input)), () => setDraft(null));
  }

  const setCond = (i: number, patch: Partial<BankRuleCondition>) =>
    setDraft((d) => d && { ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground max-w-xl">
          Rules categorize imported bank lines. The first matching rule (lowest priority number) wins. Auto-add rules record their lines at import with no review.
        </p>
        <div className="flex items-center gap-2">
          {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await applyRules();
                setMsg(r.ok ? `Recorded ${r.result.autoAdded}, suggested ${r.result.categorized}.` : r.error);
                router.refresh();
              })
            }
          >
            <Wand2 className="h-3.5 w-3.5" /> Run on For review
          </Button>
          {canEdit && (
            <Button size="sm" onClick={() => { setErr(null); setDraft(blank()); }}>
              <Plus className="h-3.5 w-3.5" /> New rule
            </Button>
          )}
        </div>
      </div>
      {err && !draft && <p className="text-xs text-destructive">{err}</p>}

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-12">#</th>
              <th className="text-left font-medium px-3 py-2">Rule</th>
              <th className="text-left font-medium px-3 py-2">When</th>
              <th className="text-left font-medium px-3 py-2">Then</th>
              <th className="text-left font-medium px-3 py-2 w-20">Active</th>
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                  No rules yet. Add one for charges that repeat: bank fees, software, rent.
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.priority}</td>
                <td className="px-3 py-2">
                  <div className="font-medium">{r.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {r.accountId ? name(choices.bankAccounts, r.accountId) : "All accounts"} · {DIRECTIONS.find((d) => d.value === r.direction)?.label}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.conditions.map((c, i) => (
                    <div key={i}>
                      {i > 0 && <span className="text-muted-foreground">{r.matchAll ? "and " : "or "}</span>}
                      {FIELDS.find((f) => f.value === c.field)?.label}{" "}
                      {[...TEXT_OPS, ...AMOUNT_OPS].find((o) => o.value === c.op)?.label} <span className="font-mono">&quot;{c.value}&quot;</span>
                    </div>
                  ))}
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.transferAccountId ? <>Transfer with {name(choices.bankAccounts, r.transferAccountId)}</> : <>Categorize to {name(choices.categories, r.categoryAccountId)}</>}
                  {(r.vendorId || r.customerId) && (
                    <div className="text-muted-foreground">
                      Payee {name([...choices.vendors, ...choices.customers], r.vendorId ?? r.customerId)}
                    </div>
                  )}
                  {r.autoAdd && <Badge variant="secondary" className="text-[9px] mt-1">Auto-add</Badge>}
                </td>
                <td className="px-3 py-2">
                  <Checkbox
                    aria-label="Active"
                    checked={r.isActive}
                    disabled={!canEdit || pending}
                    onCheckedChange={(v) => run(() => updateRule({ id: r.id, isActive: v === true }))}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  {canEdit && (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => { setErr(null); setDraft(fromRule(r)); }}>Edit</Button>
                      <Button size="icon-xs" variant="ghost" aria-label="Delete rule" disabled={pending} onClick={() => run(() => deleteRule(r.id))}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit rule" : "New bank rule"}</DialogTitle>
            <DialogDescription>When an imported line matches, suggest (or auto-add) this category and payee.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Name</Label>
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Bank fees" />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Priority</Label>
                  <Input inputMode="numeric" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Applies to</Label>
                  <Picker
                    ariaLabel="Applies to"
                    options={[{ value: "all", label: "All accounts" }, ...choices.bankAccounts.filter((a) => a.isReconciliation).map(accountOption)]}
                    value={draft.accountId || "all"}
                    onChange={(v) => setDraft({ ...draft, accountId: v === "all" ? "" : v })}
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">For</Label>
                  <Picker ariaLabel="Direction" options={DIRECTIONS} value={draft.direction} onChange={(v) => setDraft({ ...draft, direction: v })} />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Match</Label>
                  <Picker
                    ariaLabel="Match"
                    options={[{ value: "all", label: "All conditions" }, { value: "any", label: "Any condition" }]}
                    value={draft.matchAll ? "all" : "any"}
                    onChange={(v) => setDraft({ ...draft, matchAll: v !== "any" })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Conditions</div>
                {draft.conditions.map((c, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1.5fr_auto] gap-2 items-center">
                    <Picker
                      ariaLabel="Field"
                      options={FIELDS}
                      value={c.field}
                      onChange={(v) => setCond(i, { field: v as BankRuleCondition["field"], op: v === "amount" ? "equals" : "contains" })}
                    />
                    <Picker ariaLabel="Test" options={c.field === "amount" ? AMOUNT_OPS : TEXT_OPS} value={c.op} onChange={(v) => setCond(i, { op: v as BankRuleCondition["op"] })} />
                    <Input value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder={c.field === "amount" ? "25.00" : "service fee"} />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove condition"
                      disabled={draft.conditions.length === 1}
                      onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {draft.conditions.length < 10 && (
                  <Button size="xs" variant="ghost" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: "description", op: "contains", value: "" }] })}>
                    <Plus className="h-3 w-3" /> Add condition
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={draft.kind === "category"} onChange={() => setDraft({ ...draft, kind: "category" })} />
                    Categorize
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={draft.kind === "transfer"} onChange={() => setDraft({ ...draft, kind: "transfer" })} />
                    Record as a transfer
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {draft.kind === "category" ? (
                    <Picker ariaLabel="Category" options={choices.categories.map(accountOption)} value={draft.categoryAccountId} onChange={(v) => setDraft({ ...draft, categoryAccountId: v })} placeholder="Category…" />
                  ) : (
                    <Picker ariaLabel="Transfer account" options={choices.bankAccounts.map(accountOption)} value={draft.transferAccountId} onChange={(v) => setDraft({ ...draft, transferAccountId: v })} placeholder="Other account…" />
                  )}
                  <Picker ariaLabel="Payee" options={[{ value: "none", label: "No payee" }, ...payeeOptions]} value={draft.payee || "none"} onChange={(v) => setDraft({ ...draft, payee: v === "none" ? "" : v })} />
                </div>
                <Input value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} placeholder="Memo (optional)" />
              </div>

              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={draft.autoAdd} onCheckedChange={(v) => setDraft({ ...draft, autoAdd: v === true })} className="mt-0.5" />
                <span>
                  Auto-add
                  <span className="block text-[11px] text-muted-foreground">Record matching lines at import, posted, with no review. Use for charges you&apos;re sure of.</span>
                </span>
              </label>
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              disabled={pending || !draft?.name.trim() || !draft.conditions.some((c) => c.value.trim()) || (draft.kind === "category" ? !draft.categoryAccountId : !draft.transferAccountId)}
              onClick={save}
            >
              Save rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
