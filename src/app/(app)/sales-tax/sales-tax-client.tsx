"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TaxPaymentRow, LiabilityReport } from "@/lib/sales-tax/liability";
import type { TaxRateRow } from "@/lib/sales-tax/rates";
import { formatMoney, money } from "@/lib/money";
import { cn } from "@/lib/utils";
import { createAgency, createRate, recordPayment, setAgencyActive, updateRate, voidPayment } from "./actions";

type Agency = { id: string; name: string; isActive: boolean; liabilityAccountCode: string; liabilityAccountName: string; filingFrequency: string | null };
type Opt = { id: string; code: string; name: string };
type Result = { ok: boolean; error?: string };

const field = "w-full text-sm bg-background border border-border rounded-md px-2 py-2";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{children}</Label>;
}

export function SalesTaxClient({
  currency,
  period,
  presets,
  report,
  agencies,
  rates,
  payments,
  bankAccounts,
  liabilityAccounts,
}: {
  currency: string;
  period: { from: string; to: string };
  presets: Record<string, { from: string; to: string }>;
  report: LiabilityReport;
  agencies: Agency[];
  rates: TaxRateRow[];
  payments: TaxPaymentRow[];
  bankAccounts: Opt[];
  liabilityAccounts: Opt[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "agency" | "rate" | { pay: string } | { void: TaxPaymentRow }>(null);
  const fmt = (v: string) => formatMoney(v, { currency });

  function run(fn: () => Promise<Result>, after?: () => void) {
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
  const close = () => setDialog(null);

  return (
    <div className="space-y-8 max-w-6xl">
      {/* What's owed */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">What you owe</h2>
            <p className="text-xs text-muted-foreground">
              Tax on invoices and sales receipts, less credit memos and refunds, {period.from} to {period.to}. Owed is as of {period.to}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {Object.entries({ this_quarter: "This quarter", last_quarter: "Last quarter", this_year: "This year" }).map(([k, label]) => (
              <Link
                key={k}
                href={`/sales-tax?period=${k}`}
                className={cn(
                  "rounded-md px-2.5 py-1",
                  presets[k].from === period.from && presets[k].to === period.to ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                )}
              >
                {label}
              </Link>
            ))}
            <form action="/sales-tax" className="flex items-center gap-1 ml-2">
              <input type="date" name="from" defaultValue={period.from} className="rounded-md border border-border bg-background px-2 py-1" aria-label="From" />
              <input type="date" name="to" defaultValue={period.to} className="rounded-md border border-border bg-background px-2 py-1" aria-label="To" />
              <button className="rounded-md border border-border px-2.5 py-1 hover:bg-muted">Go</button>
            </form>
          </div>
        </div>

        {report.agencies.length === 0 ? (
          <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
            No sales tax set up yet. Add an agency and a rate below, then pick the rate on invoices and sales receipts.
          </div>
        ) : (
          report.agencies.map((a) => (
            <div key={a.agencyId} className="rounded-lg border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
                <div>
                  <div className="font-semibold">{a.agencyName}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Collected {fmt(a.taxCollected)} · paid {fmt(a.paymentsInPeriod)} in the period
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Owed</div>
                    <div className={cn("font-mono text-lg", money(a.balanceOwed).gt(0) && "text-foreground font-semibold")}>{fmt(a.balanceOwed)}</div>
                  </div>
                  <Button size="sm" disabled={!money(a.balanceOwed).gt(0)} onClick={() => setDialog({ pay: a.agencyId })}>
                    Record payment
                  </Button>
                </div>
              </div>
              {a.rates.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left font-medium px-4 py-2">Rate</th>
                      <th className="text-right font-medium px-3 py-2">Gross sales</th>
                      <th className="text-right font-medium px-3 py-2">Non-taxable</th>
                      <th className="text-right font-medium px-3 py-2">Taxable</th>
                      <th className="text-right font-medium px-4 py-2">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.rates.map((r) => (
                      <tr key={r.taxRateId} className="border-t border-border">
                        <td className="px-4 py-2">{r.name} <span className="text-xs text-muted-foreground">{money(r.ratePercent).toString()}%</span></td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{fmt(r.grossSales)}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{fmt(r.nonTaxableSales)}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{fmt(r.taxableSales)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmt(r.taxCollected)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
        {err && !dialog && <p className="text-xs text-destructive">{err}</p>}
      </section>

      {/* Setup */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Agencies</h2>
            <Button size="sm" variant="outline" onClick={() => { setErr(null); setDialog("agency"); }}>
              <Plus className="h-3.5 w-3.5" /> Add agency
            </Button>
          </div>
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {agencies.length === 0 && (
                  <tr><td className="px-3 py-6 text-center text-xs text-muted-foreground">None yet. Add the state (and any county or city) you collect for.</td></tr>
                )}
                {agencies.map((a) => (
                  <tr key={a.id} className="border-t border-border first:border-t-0">
                    <td className="px-3 py-2">
                      <div className={cn(!a.isActive && "text-muted-foreground line-through")}>{a.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {a.liabilityAccountCode} · {a.liabilityAccountName}
                        {a.filingFrequency ? ` · files ${a.filingFrequency}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => setAgencyActive(a.id, !a.isActive))}>
                        {a.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Rates</h2>
            <Button size="sm" variant="outline" disabled={agencies.length === 0} onClick={() => { setErr(null); setDialog("rate"); }}>
              <Plus className="h-3.5 w-3.5" /> Add rate
            </Button>
          </div>
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {rates.length === 0 && (
                  <tr><td className="px-3 py-6 text-center text-xs text-muted-foreground">None yet.</td></tr>
                )}
                {rates.map((r) => (
                  <tr key={r.id} className="border-t border-border first:border-t-0">
                    <td className="px-3 py-2">
                      <div className={cn(!r.isActive && "text-muted-foreground line-through")}>
                        {r.name} <span className="font-mono text-xs">{money(r.ratePercent).toString()}%</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {r.kind === "combined"
                          ? r.components.map((c) => `${c.name} ${money(c.ratePercent).toString()}%`).join(" + ")
                          : r.components[0]?.agencyName}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => updateRate({ id: r.id, isActive: !r.isActive }))}>
                        {r.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Payments */}
      <section className="space-y-2">
        <h2 className="font-semibold">Payments</h2>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Paid</th>
                <th className="text-left font-medium px-3 py-2">Agency</th>
                <th className="text-left font-medium px-3 py-2 w-32">Period ending</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-xs text-muted-foreground">No payments recorded.</td></tr>
              )}
              {payments.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{p.paymentNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{p.paymentDate}</td>
                  <td className="px-3 py-2">
                    {p.agencyName}
                    <div className="text-[11px] text-muted-foreground">from {p.bankAccountName}{p.reference ? ` · ${p.reference}` : ""}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{p.periodEnd}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(p.amount)}</td>
                  <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                  <td className="px-3 py-2 text-right">
                    {p.status === "posted" && (
                      <Button size="xs" variant="ghost" onClick={() => { setErr(null); setDialog({ void: p }); }}>Void</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          {dialog === "agency" && <AgencyForm liabilityAccounts={liabilityAccounts} pending={pending} err={err} onCancel={close} onSave={(v) => run(() => createAgency(v), close)} />}
          {dialog === "rate" && (
            <RateForm
              agencies={agencies.filter((a) => a.isActive)}
              singles={rates.filter((r) => r.kind === "single" && r.isActive)}
              pending={pending}
              err={err}
              onCancel={close}
              onSave={(v) => run(() => createRate(v), close)}
            />
          )}
          {dialog && typeof dialog === "object" && "pay" in dialog && (
            <PaymentForm
              agency={report.agencies.find((a) => a.agencyId === dialog.pay)!}
              periodEnd={period.to}
              bankAccounts={bankAccounts}
              currency={currency}
              pending={pending}
              err={err}
              onCancel={close}
              onSave={(v) => run(() => recordPayment(v), close)}
            />
          )}
          {dialog && typeof dialog === "object" && "void" in dialog && (
            <VoidForm payment={dialog.void} pending={pending} err={err} onCancel={close} onSave={(reason) => run(() => voidPayment(dialog.void.id, reason), close)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Footer({ pending, err, onCancel, onSave, label, disabled }: { pending: boolean; err: string | null; onCancel: () => void; onSave: () => void; label: string; disabled?: boolean }) {
  return (
    <>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button disabled={pending || disabled} onClick={onSave}>{label}</Button>
      </DialogFooter>
    </>
  );
}

function AgencyForm({
  liabilityAccounts,
  pending,
  err,
  onCancel,
  onSave,
}: {
  liabilityAccounts: Opt[];
  pending: boolean;
  err: string | null;
  onCancel: () => void;
  onSave: (v: { name: string; liabilityAccountId?: string; filingFrequency?: "monthly" | "quarterly" | "annually" }) => void;
}) {
  const [name, setName] = useState("");
  const [account, setAccount] = useState(liabilityAccounts.find((a) => a.code === "2200")?.id ?? "");
  const [freq, setFreq] = useState("quarterly");
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a sales tax agency</DialogTitle>
        <DialogDescription>Who you collect sales tax for and pay it to.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Arizona Department of Revenue" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Liability account</FieldLabel>
            <select value={account} onChange={(e) => setAccount(e.target.value)} className={field}>
              {liabilityAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel>Files</FieldLabel>
            <select value={freq} onChange={(e) => setFreq(e.target.value)} className={field}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annually">Annually</option>
            </select>
          </div>
        </div>
      </div>
      <Footer
        pending={pending}
        err={err}
        onCancel={onCancel}
        label="Add agency"
        disabled={!name.trim()}
        onSave={() => onSave({ name, liabilityAccountId: account || undefined, filingFrequency: freq as "quarterly" })}
      />
    </>
  );
}

function RateForm({
  agencies,
  singles,
  pending,
  err,
  onCancel,
  onSave,
}: {
  agencies: Agency[];
  singles: TaxRateRow[];
  pending: boolean;
  err: string | null;
  onCancel: () => void;
  onSave: (v: { name: string; agencyId?: string; ratePercent?: string; componentIds?: string[] }) => void;
}) {
  const [kind, setKind] = useState<"single" | "combined">("single");
  const [name, setName] = useState("");
  const [agencyId, setAgencyId] = useState(agencies[0]?.id ?? "");
  const [pct, setPct] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const total = singles.filter((s) => picked.has(s.id)).reduce((t, s) => t.plus(money(s.ratePercent)), money(0));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a sales tax rate</DialogTitle>
        <DialogDescription>A single rate is owed to one agency. A combined rate adds single rates together (state + county + city).</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1.5"><input type="radio" checked={kind === "single"} onChange={() => setKind("single")} /> Single</label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={kind === "combined"} onChange={() => setKind("combined")} disabled={singles.length < 2} /> Combined
          </label>
        </div>
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "single" ? "Arizona state" : "Phoenix"} autoFocus />
        </div>
        {kind === "single" ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Agency</FieldLabel>
              <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)} className={field}>
                {agencies.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel>Rate (%)</FieldLabel>
              <Input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="5.6" className="font-mono text-right" />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <FieldLabel>Components</FieldLabel>
            {singles.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={picked.has(s.id)}
                  onCheckedChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (n.has(s.id)) n.delete(s.id);
                      else n.add(s.id);
                      return n;
                    })
                  }
                />
                {s.name} <span className="text-xs text-muted-foreground">{money(s.ratePercent).toString()}% · {s.components[0]?.agencyName}</span>
              </label>
            ))}
            <div className="text-xs text-muted-foreground">Total {total.toString()}%</div>
          </div>
        )}
      </div>
      <Footer
        pending={pending}
        err={err}
        onCancel={onCancel}
        label="Add rate"
        disabled={!name.trim() || (kind === "single" ? !agencyId || !pct : picked.size < 2)}
        onSave={() => onSave(kind === "single" ? { name, agencyId, ratePercent: pct } : { name, componentIds: [...picked] })}
      />
    </>
  );
}

function PaymentForm({
  agency,
  periodEnd,
  bankAccounts,
  currency,
  pending,
  err,
  onCancel,
  onSave,
}: {
  agency: LiabilityReport["agencies"][number];
  periodEnd: string;
  bankAccounts: Opt[];
  currency: string;
  pending: boolean;
  err: string | null;
  onCancel: () => void;
  onSave: (v: { agencyId: string; paymentDate: string; periodEnd: string; amount: string; bankAccountId: string; reference?: string }) => void;
}) {
  const [amount, setAmount] = useState(money(agency.balanceOwed).toFixed(2));
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(periodEnd);
  const [bank, setBank] = useState(bankAccounts.find((a) => a.code === "1010")?.id ?? bankAccounts[0]?.id ?? "");
  const [reference, setReference] = useState("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>Pay {agency.agencyName}</DialogTitle>
        <DialogDescription>
          Owed {formatMoney(agency.balanceOwed, { currency })} as of {periodEnd}. Posts Dr the agency&apos;s liability account, Cr the bank.
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Amount</FieldLabel>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono text-right" />
        </div>
        <div>
          <FieldLabel>Payment date</FieldLabel>
          <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>For the period ending</FieldLabel>
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Paid from</FieldLabel>
          <select value={bank} onChange={(e) => setBank(e.target.value)} className={field}>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <FieldLabel>Confirmation #</FieldLabel>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      <Footer
        pending={pending}
        err={err}
        onCancel={onCancel}
        label="Record payment"
        disabled={!amount || !bank}
        onSave={() => onSave({ agencyId: agency.agencyId, paymentDate, periodEnd: end, amount, bankAccountId: bank, reference: reference || undefined })}
      />
    </>
  );
}

function VoidForm({ payment, pending, err, onCancel, onSave }: { payment: TaxPaymentRow; pending: boolean; err: string | null; onCancel: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>Void {payment.paymentNumber}?</DialogTitle>
        <DialogDescription>Posts a reversal dated today; the tax shows as owed again.</DialogDescription>
      </DialogHeader>
      <div>
        <FieldLabel>Reason</FieldLabel>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Paid from the wrong account" autoFocus />
      </div>
      <Footer pending={pending} err={err} onCancel={onCancel} label="Void payment" disabled={!reason.trim()} onSave={() => onSave(reason)} />
    </>
  );
}
