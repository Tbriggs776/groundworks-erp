"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { LotField } from "@/app/(app)/_inventory/lot-field";
import type { LotChoice } from "@/app/(app)/_inventory/purchase-items";
import { billPurchaseOrder, purchaseOrderStep, purchaseOrderWithReason, type PoStep } from "../actions";

type BillLine = {
  id: string;
  lineNumber: number;
  label: string;
  amount: string;
  remaining: string;
  unitCost: string;
  remainingQuantity: string;
  /** Inventory items only (they take a lot with specific identification). */
  itemId: string | null;
};
type Mode = "remaining" | "percent" | "custom" | "quantity";

/** Same math as the server: quantity × unit cost, and the rest of the line when the rest arrives. */
function quantityOf(l: BillLine, qty: string): Decimal {
  try {
    const q = money(qty || "0");
    return q.gt(0) && q.eq(money(l.remainingQuantity)) ? money(l.remaining) : q.times(money(l.unitCost)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } catch {
    return money(0);
  }
}

/** Same math as the server: percent of the PO line, rounded, never past what's left. */
function percentOf(l: BillLine, pct: string): Decimal {
  let amt: Decimal;
  try {
    amt = money(l.amount).times(money(pct || "0")).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } catch {
    return money(0);
  }
  const left = money(l.remaining);
  return amt.gt(left) ? left : amt;
}

const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";

export function PurchaseOrderActions({
  po,
  lines,
  lots,
  canApprove,
}: {
  po: { id: string; poNumber: string; status: string; currency: string; remainingAmount: string; sent: boolean; hasBills: boolean };
  lines: BillLine[];
  lots: { lotTracking: boolean; lots: LotChoice[] };
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<"reject" | "close" | null>(null);
  const [reason, setReason] = useState("");
  const [billOpen, setBillOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("remaining");
  const [percent, setPercent] = useState("50");
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [received, setReceived] = useState<Record<string, string>>({});
  const [lotOf, setLotOf] = useState<Record<string, { lotNumber: string; expiresOn: string }>>({});
  const [billDate, setBillDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState("");
  const fmt = (v: Decimal | string) => formatMoney(v, { currency: po.currency });
  const open = lines.filter((l) => money(l.remaining).gt(0));
  const billable = po.status === "open" && money(po.remainingAmount).gt(0);

  function amountFor(l: BillLine): Decimal {
    if (mode === "remaining") return money(l.remaining);
    if (mode === "percent") return percentOf(l, percent);
    if (mode === "quantity") return quantityOf(l, received[l.id] ?? "");
    try {
      return money(custom[l.id] || "0");
    } catch {
      return money(0);
    }
  }
  const billTotal = sumMoney(open.map(amountFor));

  function run(fn: () => Promise<{ ok: boolean; error?: string; id?: string }>, after?: (id?: string) => void) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.(r.id);
        router.refresh();
      }
    });
  }
  const step = (s: PoStep, after?: () => void) => run(() => purchaseOrderStep(s, po.id), after);

  function bill() {
    run(
      () =>
        billPurchaseOrder({
          id: po.id,
          billDate,
          vendorInvoiceNumber: vendorInvoiceNumber || undefined,
          mode,
          percent: mode === "percent" ? percent : undefined,
          lines:
            mode === "custom"
              ? open.filter((l) => custom[l.id] && money(custom[l.id]).gt(0)).map((l) => ({ purchaseOrderLineId: l.id, amount: custom[l.id] }))
              : mode === "quantity"
                ? open
                    .filter((l) => amountFor(l).gt(0))
                    .map((l) => ({
                      purchaseOrderLineId: l.id,
                      quantity: received[l.id],
                      lotNumber: lotOf[l.id]?.lotNumber || undefined,
                      lotExpiresOn: lotOf[l.id]?.expiresOn || undefined,
                    }))
                : undefined,
        }),
      (id) => {
        setBillOpen(false);
        if (id) router.push(`/ap/bills/${id}`);
      }
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {(po.status === "draft" || po.status === "rejected") && (
          <>
            <Link
              href={`/ap/purchase-orders/${po.id}/edit`}
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent"
            >
              Edit
            </Link>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => step("delete", () => router.push("/ap/purchase-orders"))}>
              Delete
            </Button>
          </>
        )}
        {po.status === "draft" && (
          <Button size="sm" disabled={pending} onClick={() => step("submit")}>
            Submit
          </Button>
        )}
        {po.status === "pending_approval" && canApprove && (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setReasonFor("reject")}>
              Reject
            </Button>
            <Button size="sm" disabled={pending} onClick={() => step("approve")}>
              Approve
            </Button>
          </>
        )}
        {po.status === "open" && (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setReasonFor("close")}>
              Close
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => step("sent")}>
              {po.sent ? "Mark sent again" : "Mark sent"}
            </Button>
          </>
        )}
        {po.status === "closed" && money(po.remainingAmount).gt(0) && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => step("reopen")}>
            Reopen
          </Button>
        )}
        {billable && (
          <Button size="sm" disabled={pending} onClick={() => setBillOpen(true)}>
            Create bill
          </Button>
        )}
      </div>
      {err && !billOpen && !reasonFor && <p className="text-xs text-destructive max-w-sm text-right">{err}</p>}

      <Dialog open={reasonFor !== null} onOpenChange={(o) => !o && setReasonFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reasonFor === "reject" ? `Reject ${po.poNumber}?` : `Close ${po.poNumber}?`}</DialogTitle>
            <DialogDescription>
              {reasonFor === "reject"
                ? "Sends it back. It can be edited and submitted again."
                : "Nothing more will be billed from it. Bills already made stay as they are; you can reopen it later."}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label className={label}>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonFor === "reject" ? "Over budget" : "Rest is back-ordered"} autoFocus />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReasonFor(null)}>Cancel</Button>
            <Button
              variant={reasonFor === "reject" ? "destructive" : "default"}
              disabled={pending || !reason.trim()}
              onClick={() => run(() => purchaseOrderWithReason(reasonFor!, po.id, reason), () => setReasonFor(null))}
            >
              {reasonFor === "reject" ? "Reject" : "Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={billOpen} onOpenChange={setBillOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bill {po.poNumber}</DialogTitle>
            <DialogDescription>
              Creates a draft bill with the PO&apos;s accounts and descriptions. {fmt(po.remainingAmount)} is left to bill.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How much to bill">
              {(
                [
                  ["remaining", "Everything left"],
                  ["percent", "A percent of each line"],
                  ["custom", "A custom amount per line"],
                  ["quantity", "Quantity received per line"],
                ] as const
              ).map(([m, name]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-md border px-3 py-1.5 text-xs ${mode === m ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border text-muted-foreground hover:bg-accent"}`}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <Label className={label}>Bill date</Label>
                <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} aria-label="Bill date" />
              </div>
              <div>
                <Label className={label}>Vendor invoice #</Label>
                <Input value={vendorInvoiceNumber} onChange={(e) => setVendorInvoiceNumber(e.target.value)} placeholder="Optional" aria-label="Vendor invoice number" />
              </div>
              {mode === "percent" && (
                <div>
                  <Label className={label}>Percent</Label>
                  <Input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Percent" />
                </div>
              )}
            </div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto max-h-72">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Line</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Left</th>
                    <th className="text-right font-medium px-3 py-2 w-32">This bill</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((l) => (
                    <tr key={l.id} className="border-t border-border">
                      <td className="px-3 py-2 text-xs">
                        <span className="font-mono text-muted-foreground mr-2">{l.lineNumber}</span>
                        {l.label}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {fmt(l.remaining)}
                        {mode === "quantity" && <div className="text-[10px] text-muted-foreground">{money(l.remainingQuantity).toString()} to receive</div>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {mode === "quantity" ? (
                          <div className="space-y-1">
                            <input
                              inputMode="decimal"
                              aria-label={`Line ${l.lineNumber} quantity received`}
                              value={received[l.id] ?? ""}
                              onChange={(e) => setReceived((c) => ({ ...c, [l.id]: e.target.value }))}
                              placeholder="Qty"
                              className="w-full text-xs bg-background border border-border rounded-md px-2 py-1 text-right font-mono"
                            />
                            {lots.lotTracking && l.itemId && (
                              <LotField
                                lots={lots.lots}
                                itemId={l.itemId}
                                value={lotOf[l.id]?.lotNumber ?? ""}
                                onChange={(v) => setLotOf((c) => ({ ...c, [l.id]: { lotNumber: v, expiresOn: c[l.id]?.expiresOn ?? "" } }))}
                                incoming
                                expiresOn={lotOf[l.id]?.expiresOn ?? ""}
                                onExpiresOn={(v) => setLotOf((c) => ({ ...c, [l.id]: { lotNumber: c[l.id]?.lotNumber ?? "", expiresOn: v } }))}
                              />
                            )}
                            <div>{fmt(amountFor(l))}</div>
                          </div>
                        ) : mode === "custom" ? (
                          <input
                            inputMode="decimal"
                            aria-label={`Line ${l.lineNumber} amount`}
                            value={custom[l.id] ?? ""}
                            onChange={(e) => setCustom((c) => ({ ...c, [l.id]: e.target.value }))}
                            placeholder="0.00"
                            className="w-full text-xs bg-background border border-border rounded-md px-2 py-1 text-right font-mono"
                          />
                        ) : (
                          fmt(amountFor(l))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/30">
                  <tr className="border-t-2 border-border">
                    <td colSpan={2} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Bill total</td>
                    <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{fmt(billTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {err && <p className="text-xs text-destructive">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBillOpen(false)}>Cancel</Button>
            <Button disabled={pending || !billTotal.gt(0)} onClick={bill}>
              {pending ? "Creating…" : "Create bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
