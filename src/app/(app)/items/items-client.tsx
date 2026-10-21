"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ItemRow } from "@/lib/ar/items";
import type { Account, Item } from "@/lib/db/schema";
import { formatMoney, money } from "@/lib/money";
import { createItem, updateItem, type ItemInput } from "./actions";

const selectClass =
  "w-full text-sm bg-background border border-border rounded-md px-2 py-2";

const TYPE_LABEL: Record<Item["type"], string> = { service: "Service", non_inventory: "Non-inventory", inventory: "Inventory" };

export function ItemsClient({ items, accounts, today }: { items: ItemRow[]; accounts: Account[]; today: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(s) ||
        (i.sku ?? "").toLowerCase().includes(s) ||
        (i.description ?? "").toLowerCase().includes(s)
    );
  }, [items, q]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, SKU, or description…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          New item
        </Button>
      </div>

      <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 w-28">SKU</th>
              <th className="text-left font-medium px-3 py-2 w-28">Type</th>
              <th className="text-left font-medium px-3 py-2">Income account</th>
              <th className="text-right font-medium px-3 py-2 w-28">On hand</th>
              <th className="text-right font-medium px-3 py-2 w-32">Price</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                  {items.length === 0
                    ? "No products or services yet. Add what you sell so invoices fill themselves in."
                    : "No items match."}
                </td>
              </tr>
            )}
            {filtered.map((i) => {
              const income = accountById.get(i.incomeAccountId);
              return (
                <tr
                  key={i.id}
                  onClick={() => {
                    setEditing(i);
                    setOpen(true);
                  }}
                  className="border-t border-border hover:bg-accent/30 cursor-pointer"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {i.name}
                      {!i.isActive && (
                        <Badge variant="outline" className="text-[9px]">Inactive</Badge>
                      )}
                    </div>
                    {i.description && (
                      <div className="text-[11px] text-muted-foreground truncate max-w-md">
                        {i.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{i.sku ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {TYPE_LABEL[i.type]}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {income ? (
                      <>
                        <span className="font-mono text-primary">{income.code}</span> {income.name}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {i.onHand === null ? (
                      "—"
                    ) : (
                      <Link
                        href={`/items/${i.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className={`hover:underline ${money(i.onHand).lt(0) ? "text-destructive" : i.reorderPoint !== null && money(i.onHand).lte(money(i.reorderPoint)) ? "text-amber-600" : "text-primary"}`}
                        title="Stock and history"
                      >
                        {money(i.onHand).toDecimalPlaces(4).toString()}
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {i.salesPrice ? formatMoney(i.salesPrice) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ItemForm
        key={editing?.id ?? "new"}
        open={open}
        onOpenChange={setOpen}
        initial={editing}
        accounts={accounts}
        today={today}
      />
    </div>
  );
}

function ItemForm({
  open,
  onOpenChange,
  initial,
  accounts,
  today,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: Item | null;
  accounts: Account[];
  today: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const incomeAccounts = accounts.filter((a) => a.category === "income_statement" && a.normalBalance === "credit");
  const defaultIncome =
    incomeAccounts.find((a) => a.code === "4100") ?? incomeAccounts[0];

  const [name, setName] = useState(initial?.name ?? "");
  const [sku, setSku] = useState(initial?.sku ?? "");
  const [type, setType] = useState<Item["type"]>(initial?.type ?? "service");
  const assetAccounts = accounts.filter((a) => a.subcategory === "inventory");
  const costAccounts = accounts.filter((a) => a.category === "income_statement" && a.normalBalance === "debit");
  const [assetAccountId, setAssetAccountId] = useState(initial?.assetAccountId ?? assetAccounts[0]?.id ?? "");
  const [reorderPoint, setReorderPoint] = useState(initial?.reorderPoint ?? "");
  const [openingQty, setOpeningQty] = useState("");
  const [openingAsOf, setOpeningAsOf] = useState(today);
  const inventory = type === "inventory";
  const [description, setDescription] = useState(initial?.description ?? "");
  const [salesPrice, setSalesPrice] = useState(initial?.salesPrice ?? "");
  const [incomeAccountId, setIncomeAccountId] = useState(
    initial?.incomeAccountId ?? defaultIncome?.id ?? ""
  );
  const [expenseAccountId, setExpenseAccountId] = useState(initial?.expenseAccountId ?? "");
  const [purchaseCost, setPurchaseCost] = useState(initial?.purchaseCost ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const defaultCogs =
    costAccounts.find((a) => a.code === "5050") ??
    costAccounts.find((a) => a.subcategory === "cogs_materials") ??
    costAccounts.find((a) => a.subcategory.startsWith("cogs"));
  const [taxable, setTaxable] = useState(initial?.taxable ?? true);

  function submit() {
    setErr(null);
    start(async () => {
      const payload: ItemInput = {
        name: name.trim(),
        sku,
        type,
        description,
        salesPrice: salesPrice || null,
        incomeAccountId,
        purchaseCost: purchaseCost || null,
        expenseAccountId: expenseAccountId || (inventory ? defaultCogs?.id : undefined) || null,
        taxable,
        isActive,
        ...(inventory
          ? {
              assetAccountId: assetAccountId || null,
              reorderPoint: reorderPoint || null,
              ...(!initial && openingQty
                ? { openingStock: { quantity: openingQty, unitCost: purchaseCost || undefined, asOf: openingAsOf } }
                : {}),
            }
          : {}),
      };
      const r = initial ? await updateItem(initial.id, payload) : await createItem(payload);
      if (r.ok) {
        onOpenChange(false);
        router.refresh();
      } else setErr(r.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-heading tracking-[0.12em]">
            {initial ? "EDIT ITEM" : "NEW PRODUCT OR SERVICE"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Consulting" autoFocus />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">SKU</Label>
              <Input value={sku} onChange={(e) => setSku(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Type</Label>
              <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className={selectClass}>
                <option value="service">Service</option>
                <option value="non_inventory">Non-inventory product</option>
                <option value="inventory">Inventory product (track quantity)</option>
              </select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Sales price</Label>
              <Input inputMode="decimal" value={salesPrice} onChange={(e) => setSalesPrice(e.target.value)} className="font-mono text-right" placeholder="0.00" />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Description on invoices</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Income account</Label>
            <select value={incomeAccountId} onChange={(e) => setIncomeAccountId(e.target.value)} className={selectClass}>
              {incomeAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                {inventory ? "Cost of goods sold account" : "Expense account (when purchased)"}
              </Label>
              <select
                value={expenseAccountId || (inventory ? (defaultCogs?.id ?? "") : "")}
                onChange={(e) => setExpenseAccountId(e.target.value)}
                className={selectClass}
              >
                {!inventory && <option value="">—</option>}
                {costAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Cost</Label>
              <Input inputMode="decimal" value={purchaseCost} onChange={(e) => setPurchaseCost(e.target.value)} className="font-mono text-right" placeholder="0.00" />
            </div>
          </div>
          {inventory && (
            <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Inventory asset account</Label>
                <select value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)} className={selectClass}>
                  {assetAccounts.length === 0 && <option value="">Add an inventory account first</option>}
                  {assetAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Reorder point</Label>
                <Input inputMode="decimal" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} className="font-mono text-right" />
              </div>
            </div>
          )}
          {inventory && !initial && (
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="text-xs text-muted-foreground">
                Quantity on hand now (optional). Posts opening stock at the cost above, against Opening Balance Equity.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Initial quantity</Label>
                  <Input inputMode="decimal" value={openingQty} onChange={(e) => setOpeningQty(e.target.value)} className="font-mono text-right" placeholder="0" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">As of</Label>
                  <Input type="date" value={openingAsOf} onChange={(e) => setOpeningAsOf(e.target.value)} />
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox checked={taxable} onCheckedChange={(c) => setTaxable(!!c)} />
              <span>Taxable (charge sales tax when sold)</span>
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox checked={isActive} onCheckedChange={(c) => setIsActive(!!c)} />
              <span>Active</span>
            </label>
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending || !name.trim() || !incomeAccountId} onClick={submit}>
            {pending ? "Saving…" : initial ? "Save changes" : "Create item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
