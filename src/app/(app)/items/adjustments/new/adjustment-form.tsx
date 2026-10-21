"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ItemRow } from "@/lib/ar/items";
import type { Account } from "@/lib/db/schema";
import { formatMoney, money } from "@/lib/money";
import { LotField } from "@/app/(app)/_inventory/lot-field";
import type { LotChoice } from "@/app/(app)/_inventory/purchase-items";
import { createAdjustment } from "../../inventory-actions";

type AccountOption = Pick<Account, "id" | "code" | "name" | "category" | "subcategory">;
type Line = { key: number; itemId: string; change: string; unitCost: string; lotNumber: string; lotExpiresOn: string };

const selectClass = "w-full text-sm bg-background border border-border rounded-md px-2 py-2";
const num = (v: string) => {
  try {
    return v.trim() ? money(v) : null;
  } catch {
    return null;
  }
};

/** Change quantities on hand: type the change, or the new quantity counted. */
export function AdjustmentForm({
  items,
  accounts,
  lots,
  today,
  presetItemId,
}: {
  items: ItemRow[];
  accounts: AccountOption[];
  lots: { lotTracking: boolean; lots: LotChoice[] };
  today: string;
  presetItemId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const byId = new Map(items.map((i) => [i.id, i]));
  const costAccounts = accounts.filter((a) => a.category === "income_statement" && !a.subcategory.endsWith("revenue"));
  const defaultOffset =
    costAccounts.find((a) => /shrink/i.test(a.name)) ?? costAccounts.find((a) => a.code === "5050") ?? costAccounts.find((a) => a.subcategory.startsWith("cogs"));
  const [date, setDate] = useState(today);
  const [offsetAccountId, setOffsetAccountId] = useState(defaultOffset?.id ?? "");
  const [memo, setMemo] = useState("");
  const [next, setNext] = useState(1);
  const [lines, setLines] = useState<Line[]>([
    { key: 0, itemId: presetItemId && byId.has(presetItemId) ? presetItemId : "", change: "", unitCost: "", lotNumber: "", lotExpiresOn: "" },
  ]);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lotOf = (l: Line) => lots.lots.find((x) => x.itemId === l.itemId && x.lotNumber === l.lotNumber);
  // With lots, on hand is the lot's.
  const onHandOf = (l: Line) => (lots.lotTracking ? money(lotOf(l)?.onHand ?? 0) : money(byId.get(l.itemId)?.onHand ?? 0));
  const avgOf = (itemId: string) => {
    const i = byId.get(itemId);
    const q = money(i?.onHand ?? 0);
    return q.gt(0) ? money(i?.stockValue ?? 0).div(q) : money(i?.purchaseCost ?? 0);
  };

  function submit() {
    setErr(null);
    start(async () => {
      const r = await createAdjustment({
        adjustmentDate: date,
        offsetAccountId,
        memo: memo || undefined,
        lines: lines
          .filter((l) => l.itemId && num(l.change) && !num(l.change)!.isZero())
          .map((l) => ({
            itemId: l.itemId,
            quantity: l.change,
            unitCost: num(l.change)!.gt(0) && l.unitCost ? l.unitCost : undefined,
            ...(lots.lotTracking ? { lotNumber: l.lotNumber || undefined, lotExpiresOn: num(l.change)!.gt(0) ? l.lotExpiresOn || undefined : undefined } : {}),
          })),
      });
      if (r.ok && "id" in r) router.push(`/items/adjustments/${r.id}`);
      else if (!r.ok) setErr(r.error);
    });
  }

  const ready = Boolean(offsetAccountId) && lines.some((l) => l.itemId && num(l.change) && !num(l.change)!.isZero());

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No inventory items yet. Make a product an inventory item first (Products &amp; Services).</p>;
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Offset account</Label>
          <select value={offsetAccountId} onChange={(e) => setOffsetAccountId(e.target.value)} className={selectClass}>
            <option value="">Choose…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground mt-1">Usually inventory shrinkage or cost of goods sold.</p>
        </div>
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Memo</Label>
        <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Year-end count" />
      </div>

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">Product</th>
              <th className="text-right font-medium px-3 py-2 w-24">On hand</th>
              <th className="text-right font-medium px-3 py-2 w-28">New qty</th>
              <th className="text-right font-medium px-3 py-2 w-28">Change</th>
              <th className="text-right font-medium px-3 py-2 w-32">Unit cost</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const onHand = l.itemId ? onHandOf(l) : null;
              const change = num(l.change);
              const adding = change?.gt(0) ?? false;
              return (
                <tr key={l.key} className="border-t border-border">
                  <td className="px-3 py-2">
                    <select value={l.itemId} onChange={(e) => update(l.key, { itemId: e.target.value, lotNumber: "", lotExpiresOn: "" })} className={selectClass}>
                      <option value="">Choose a product…</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ""}</option>
                      ))}
                    </select>
                    {lots.lotTracking && l.itemId && (
                      <div className="mt-1">
                        <LotField
                          lots={lots.lots}
                          itemId={l.itemId}
                          value={l.lotNumber}
                          onChange={(v) => update(l.key, { lotNumber: v })}
                          incoming={!change || change.gt(0)}
                          expiresOn={l.lotExpiresOn}
                          onExpiresOn={(v) => update(l.key, { lotExpiresOn: v })}
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{onHand ? onHand.toDecimalPlaces(4).toString() : "—"}</td>
                  <td className="px-3 py-2">
                    <Input
                      inputMode="decimal"
                      className="font-mono text-right"
                      disabled={!onHand}
                      value={onHand && change ? onHand.plus(change).toDecimalPlaces(4).toString() : ""}
                      onChange={(e) => {
                        const n = num(e.target.value);
                        update(l.key, { change: n && onHand ? n.minus(onHand).toString() : "" });
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input inputMode="decimal" className="font-mono text-right" value={l.change} onChange={(e) => update(l.key, { change: e.target.value })} placeholder="+/−" />
                  </td>
                  <td className="px-3 py-2">
                    {adding ? (
                      <Input
                        inputMode="decimal"
                        className="font-mono text-right"
                        value={l.unitCost}
                        onChange={(e) => update(l.key, { unitCost: e.target.value })}
                        placeholder={l.itemId ? avgOf(l.itemId).toFixed(2) : "0.00"}
                      />
                    ) : (
                      <div className="text-right text-[11px] text-muted-foreground">{change ? "by costing method" : ""}</div>
                    )}
                  </td>
                  <td className="px-1 py-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setLines((ls) => [...ls, { key: next, itemId: "", change: "", unitCost: "", lotNumber: "", lotExpiresOn: "" }]);
            setNext(next + 1);
          }}
        >
          <Plus className="h-3.5 w-3.5" /> Add line
        </Button>
        <div className="text-xs text-muted-foreground">
          Stock added at{" "}
          {formatMoney(
            lines.reduce((acc, l) => {
              const c = num(l.change);
              if (!l.itemId || !c?.gt(0)) return acc;
              return acc.plus(c.times(num(l.unitCost) ?? avgOf(l.itemId)));
            }, money(0))
          )}
          ; stock removed is costed when it posts.
        </div>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => router.push("/items/adjustments")}>Cancel</Button>
        <Button disabled={pending || !ready} onClick={submit}>{pending ? "Posting…" : "Post adjustment"}</Button>
      </div>
    </div>
  );
}
