"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  Account,
  ApBill,
  Vendor,
} from "@/lib/db/schema";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { createPayment, postPayment, type PaymentInput } from "../actions";

export type OpenBill = ApBill & { openBalance: string };

type AppRow = {
  billId: string;
  selected: boolean;
  appliedAmount: string;
  discountAmount: string;
};

export function PaymentForm({
  vendors,
  bankAccounts,
  openBillsByVendor,
}: {
  vendors: Vendor[];
  bankAccounts: Account[];
  openBillsByVendor: Record<string, OpenBill[]>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [vendorId, setVendorId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);
  const [method, setMethod] = useState<PaymentInput["method"]>("check");
  const [reference, setReference] = useState("");
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? "");
  const [memo, setMemo] = useState("");

  const [apps, setApps] = useState<Record<string, AppRow>>({});

  const openBills = vendorId ? openBillsByVendor[vendorId] ?? [] : [];

  // Reset applications when vendor changes
  function onVendorChange(v: string) {
    setVendorId(v);
    setApps({});
  }

  function toggleBill(bill: OpenBill) {
    setApps((prev) => {
      const existing = prev[bill.id];
      if (existing?.selected) {
        const next = { ...prev };
        delete next[bill.id];
        return next;
      }
      return {
        ...prev,
        [bill.id]: {
          billId: bill.id,
          selected: true,
          appliedAmount: bill.openBalance,
          discountAmount: "0",
        },
      };
    });
  }

  function updateApp(billId: string, patch: Partial<AppRow>) {
    setApps((prev) => ({ ...prev, [billId]: { ...prev[billId], ...patch } }));
  }

  const selected = Object.values(apps).filter((a) => a.selected);
  const totals = useMemo(() => {
    const applied = sumMoney(
      selected.flatMap((a) => [a.appliedAmount || "0", a.discountAmount || "0"])
    );
    const discount = sumMoney(selected.map((a) => a.discountAmount || "0"));
    const net = applied.minus(discount);
    return { applied, discount, net };
  }, [selected]);

  const currency = "USD";

  async function save(thenPost: boolean) {
    setErr(null);
    start(async () => {
      const payload: PaymentInput = {
        vendorId,
        paymentDate,
        method,
        reference,
        bankAccountId,
        currency,
        exchangeRate: "1",
        memo,
        applications: selected.map((a) => ({
          billId: a.billId,
          appliedAmount: a.appliedAmount || "0",
          discountAmount: a.discountAmount || "0",
        })),
      };
      const r = await createPayment(payload);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      if (thenPost) {
        const p = await postPayment(r.id);
        if (!p.ok) {
          setErr(`Saved draft, but posting failed: ${p.error}`);
          router.push(`/ap/payments/${r.id}`);
          return;
        }
      }
      router.push(`/ap/payments/${r.id}`);
    });
  }

  const canSave =
    !pending &&
    vendorId &&
    paymentDate &&
    bankAccountId &&
    selected.length > 0 &&
    selected.every(
      (a) => money(a.appliedAmount || "0").gt(0)
    );

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Vendor
          </Label>
          <Select value={vendorId} onValueChange={(v) => onVendorChange(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="— choose vendor —" />
            </SelectTrigger>
            <SelectContent>
              {vendors.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.code} — {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Payment date
          </Label>
          <Input
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Method
          </Label>
          <Select
            value={method}
            onValueChange={(v) =>
              setMethod((v ?? "check") as PaymentInput["method"])
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="check">Check</SelectItem>
              <SelectItem value="ach">ACH</SelectItem>
              <SelectItem value="wire">Wire</SelectItem>
              <SelectItem value="credit_card">Credit card</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Bank account
          </Label>
          <Select value={bankAccountId} onValueChange={(v) => setBankAccountId(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="— choose bank —" />
            </SelectTrigger>
            <SelectContent>
              {bankAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            Reference (check # / ACH trace)
          </Label>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="1234"
          />
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-2">
          Open bills for this vendor
        </div>
        {!vendorId && (
          <p className="text-xs text-muted-foreground">
            Select a vendor above to see their open bills.
          </p>
        )}
        {vendorId && openBills.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No open bills for this vendor.
          </p>
        )}
        {vendorId && openBills.length > 0 && (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2 w-10"></th>
                  <th className="text-left font-medium px-3 py-2 w-28">Bill #</th>
                  <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                  <th className="text-left font-medium px-3 py-2 w-28">Due</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Open</th>
                  <th className="text-right font-medium px-3 py-2 w-36">Apply</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Discount</th>
                </tr>
              </thead>
              <tbody>
                {openBills.map((bill) => {
                  const app = apps[bill.id];
                  const selected = !!app?.selected;
                  const discountEligible =
                    bill.discountDate && bill.discountDate >= paymentDate;
                  return (
                    <tr
                      key={bill.id}
                      className={`border-t border-border ${
                        selected ? "bg-primary/5" : ""
                      }`}
                    >
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleBill(bill)}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-primary">
                        {bill.billNumber}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                        {bill.billDate}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                        {bill.dueDate}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {formatMoney(bill.openBalance, { currency: bill.currency })}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          disabled={!selected}
                          value={app?.appliedAmount ?? ""}
                          onChange={(e) =>
                            updateApp(bill.id, { appliedAmount: e.target.value })
                          }
                          className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-right font-mono disabled:opacity-30"
                          placeholder="0.00"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          disabled={!selected}
                          value={app?.discountAmount ?? "0"}
                          onChange={(e) =>
                            updateApp(bill.id, { discountAmount: e.target.value })
                          }
                          className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-right font-mono disabled:opacity-30"
                          placeholder="0.00"
                        />
                        {selected && discountEligible && (
                          <div className="text-[9px] text-[var(--gw-green-bright)] text-right mt-0.5">
                            Discount eligible
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 border-t-2 border-border">
                  <td></td>
                  <td
                    colSpan={4}
                    className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                  >
                    Totals — applied {formatMoney(totals.applied)} · discount{" "}
                    {formatMoney(totals.discount)} · net cash out
                  </td>
                  <td
                    colSpan={2}
                    className="px-3 py-2 text-right font-mono text-sm font-semibold"
                  >
                    {formatMoney(totals.net, { currency })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
          Memo
        </Label>
        <Textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          rows={2}
        />
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <div className="flex items-center gap-3 pt-3 border-t border-border">
        <Button onClick={() => save(false)} disabled={!canSave}>
          {pending ? "Saving…" : "Save draft"}
        </Button>
        <Button onClick={() => save(true)} disabled={!canSave} variant="default">
          {pending ? "Posting…" : "Save & post"}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/ap/payments")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
