"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UndepositedPayment } from "@/lib/banking/transactions";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { createDeposit, createExpense, createTransfer } from "../actions";
import type { BankingChoices } from "../choices";
import { accountOption, Picker } from "../picker";

export type TxnType = "expense" | "check" | "deposit" | "transfer";

type Line = { key: number; accountId: string; amount: string; description: string; customerId: string };

const METHODS = [
  { value: "credit_card", label: "Credit card" },
  { value: "ach", label: "ACH / debit" },
  { value: "wire", label: "Wire" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{children}</Label>;
}

/** Expense, check, deposit, or transfer: one form, shaped by type. */
export function BankTxnForm({
  type,
  defaultAccountId,
  choices,
  undeposited,
  currency,
}: {
  type: TxnType;
  defaultAccountId?: string;
  choices: BankingChoices;
  undeposited: UndepositedPayment[];
  currency: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const banks = choices.bankAccounts;
  const firstBank = banks.find((a) => a.id === defaultAccountId)?.id ?? banks[0]?.id ?? "";

  const [txnDate, setTxnDate] = useState(today);
  const [bankAccountId, setBankAccountId] = useState(firstBank);
  const [toAccountId, setToAccountId] = useState("");
  const [payee, setPayee] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [method, setMethod] = useState("credit_card");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentIds, setPaymentIds] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Line[]>(type === "deposit" ? [] : [{ key: 1, accountId: "", amount: "", description: "", customerId: "" }]);

  const payeeOptions = useMemo(
    () => [
      ...choices.vendors.map((v) => ({ value: `v:${v.id}`, label: `${v.name} (vendor)` })),
      ...choices.customers.map((c) => ({ value: `c:${c.id}`, label: `${c.name} (customer)` })),
    ],
    [choices]
  );
  const categoryOptions = choices.categories.filter((c) => c.id !== bankAccountId).map(accountOption);
  const customerOptions = choices.customers.map((c) => ({ value: c.id, label: c.name }));

  const paymentsTotal = sumMoney(undeposited.filter((p) => paymentIds.has(p.id)).map((p) => p.amount));
  const linesTotal = sumMoney(lines.map((l) => l.amount || "0"));
  const total = type === "transfer" ? money(amount || "0") : paymentsTotal.plus(linesTotal);

  const updateLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addRow = () => setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, accountId: "", amount: "", description: "", customerId: "" }]);

  const filledLines = lines.filter((l) => l.accountId && l.amount);
  const payeeFields = {
    vendorId: payee.startsWith("v:") ? payee.slice(2) : undefined,
    customerId: payee.startsWith("c:") ? payee.slice(2) : undefined,
    payeeName: payeeName || undefined,
  };

  function save(post: boolean) {
    setErr(null);
    start(async () => {
      const lineInput = filledLines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        description: l.description || undefined,
        customerId: l.customerId || undefined,
      }));
      const r =
        type === "transfer"
          ? await createTransfer({ txnDate, fromAccountId: bankAccountId, toAccountId, amount, reference: reference || undefined, memo: memo || undefined, post })
          : type === "deposit"
            ? await createDeposit({
                txnDate,
                bankAccountId,
                paymentIds: [...paymentIds],
                lines: lineInput,
                ...payeeFields,
                reference: reference || undefined,
                memo: memo || undefined,
                post,
              })
            : await createExpense({
                type,
                txnDate,
                bankAccountId,
                ...payeeFields,
                method: type === "check" ? "check" : (method as "credit_card"),
                reference: reference || undefined,
                memo: memo || undefined,
                lines: lineInput,
                post,
              });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      router.push(`/banking/transactions/${r.id}`);
    });
  }

  const canSave =
    !pending &&
    !!txnDate &&
    !!bankAccountId &&
    (type === "transfer"
      ? !!toAccountId && toAccountId !== bankAccountId && money(amount || "0").gt(0)
      : type === "deposit"
        ? paymentIds.size + filledLines.length > 0
        : filledLines.length > 0);

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <FieldLabel>{type === "deposit" ? "Deposit to" : type === "transfer" ? "Transfer from" : "Paid from"}</FieldLabel>
          <Picker ariaLabel="Bank account" options={banks.map(accountOption)} value={bankAccountId} onChange={setBankAccountId} placeholder="Choose account…" />
        </div>
        {type === "transfer" ? (
          <div>
            <FieldLabel>Transfer to</FieldLabel>
            <Picker
              ariaLabel="Transfer to"
              options={choices.bankAccounts.filter((a) => a.id !== bankAccountId).map(accountOption)}
              value={toAccountId}
              onChange={setToAccountId}
              placeholder="Choose account…"
            />
          </div>
        ) : (
          <div>
            <FieldLabel>{type === "deposit" ? "Received from (optional)" : "Payee"}</FieldLabel>
            <Picker ariaLabel="Payee" options={payeeOptions} value={payee} onChange={setPayee} placeholder="Vendor or customer…" />
            <Input className="mt-1.5" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Or type a name" />
          </div>
        )}
        <div>
          <FieldLabel>Date</FieldLabel>
          <Input type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {type === "expense" && (
          <div>
            <FieldLabel>Payment method</FieldLabel>
            <Picker ariaLabel="Payment method" options={METHODS} value={method} onChange={setMethod} />
          </div>
        )}
        <div>
          <FieldLabel>{type === "check" ? "Check number" : "Reference"}</FieldLabel>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={type === "check" ? "1001" : "Optional"} />
        </div>
        {type === "transfer" && (
          <div>
            <FieldLabel>Amount</FieldLabel>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="font-mono text-right" />
          </div>
        )}
      </div>

      {type === "deposit" && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-2">Payments waiting in Undeposited Funds</div>
          {undeposited.length === 0 ? (
            <p className="text-xs text-muted-foreground">None. Payments you receive into Undeposited Funds show up here to group into one deposit.</p>
          ) : (
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {undeposited.map((p) => (
                    <tr key={p.id} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-2 w-8">
                        <Checkbox
                          aria-label={`Include ${p.paymentNumber}`}
                          checked={paymentIds.has(p.id)}
                          onCheckedChange={() =>
                            setPaymentIds((s) => {
                              const n = new Set(s);
                              if (n.has(p.id)) n.delete(p.id);
                              else n.add(p.id);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground w-28">{p.paymentDate}</td>
                      <td className="px-3 py-2">{p.customerName}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {p.paymentNumber} · {p.method.replace(/_/g, " ")}
                        {p.reference ? ` #${p.reference}` : ""}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs w-32">{formatMoney(p.amount, { currency })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {type !== "transfer" && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-2">
            {type === "deposit" ? "Other money in this deposit" : "Category details"}
          </div>
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2 w-72">{type === "deposit" ? "Account" : "Category"}</th>
                  <th className="text-left font-medium px-3 py-2">Description</th>
                  {type === "deposit" && <th className="text-left font-medium px-3 py-2 w-48">Received from</th>}
                  <th className="text-right font-medium px-3 py-2 w-36">Amount</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Picker ariaLabel="Category" options={categoryOptions} value={l.accountId} onChange={(v) => updateLine(l.key, { accountId: v })} placeholder="Choose…" />
                    </td>
                    <td className="px-3 py-2">
                      <Input value={l.description} onChange={(e) => updateLine(l.key, { description: e.target.value })} />
                    </td>
                    {type === "deposit" && (
                      <td className="px-3 py-2">
                        <Picker ariaLabel="Received from" options={customerOptions} value={l.customerId} onChange={(v) => updateLine(l.key, { customerId: v })} placeholder="Optional" />
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <Input
                        inputMode="decimal"
                        value={l.amount}
                        onChange={(e) => updateLine(l.key, { amount: e.target.value })}
                        placeholder="0.00"
                        className="font-mono text-right"
                      />
                    </td>
                    <td className="px-1 py-2">
                      <Button size="icon-sm" variant="ghost" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={addRow}>
            <Plus className="h-3.5 w-3.5" /> Add line
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
        <div>
          <FieldLabel>Memo</FieldLabel>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</div>
          <div className="font-mono text-2xl">{formatMoney(total.toFixed(4), { currency })}</div>
        </div>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!canSave} onClick={() => save(false)}>
          Save draft
        </Button>
        <Button disabled={!canSave} onClick={() => save(true)}>
          Save and post
        </Button>
      </div>
    </div>
  );
}
