"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/money";
import { startReconciliation } from "../actions";
import { accountOption, Picker } from "../picker";

type Acct = {
  id: string;
  code: string;
  name: string;
  card: boolean;
  lastReconciled: { date: string; balance: string } | null;
  inProgressId: string | null;
  bankBalance: string | null;
  bankBalanceDate: string | null;
};

export function StartReconciliation({ accounts, defaultAccountId, currency }: { accounts: Acct[]; defaultAccountId?: string; currency: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [accountId, setAccountId] = useState(accounts.find((a) => a.id === defaultAccountId)?.id ?? accounts[0]?.id ?? "");
  const [endDate, setEndDate] = useState("");
  const [balance, setBalance] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === accountId);
  const fmt = (v: string) => formatMoney(v, { currency });

  if (accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">No reconcilable bank or card accounts yet.</p>;
  }

  function begin() {
    setErr(null);
    start(async () => {
      const r = await startReconciliation({ accountId, statementEndDate: endDate, statementEndingBalance: balance });
      if (!r.ok) setErr(r.error);
      else router.push(`/banking/reconcile/${r.id}`);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div>
        <div className="font-semibold">Reconcile an account</div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Open your statement. Enter its ending date and balance, then tick each item that appears on it until the difference is zero.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Account</Label>
          <Picker ariaLabel="Account" options={accounts.map(accountOption)} value={accountId} onChange={setAccountId} />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Statement ending date</Label>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
            {account?.card ? "Ending balance owed" : "Ending balance"}
          </Label>
          <Input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" className="font-mono text-right" />
        </div>
      </div>
      {account && (
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          <div>
            {account.lastReconciled
              ? `Last reconciled through ${account.lastReconciled.date}, ending at ${fmt(account.lastReconciled.balance)}. That's the beginning balance.`
              : "First reconciliation for this account: the beginning balance is zero."}
          </div>
          {account.bankBalance && (
            <div>
              The last import reported {fmt(account.bankBalance)}
              {account.bankBalanceDate ? ` as of ${account.bankBalanceDate}` : ""}.{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  setBalance(Number(account.bankBalance).toFixed(2));
                  if (account.bankBalanceDate) setEndDate(account.bankBalanceDate);
                }}
              >
                Use it
              </button>
            </div>
          )}
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end">
        {account?.inProgressId ? (
          <Button onClick={() => router.push(`/banking/reconcile/${account.inProgressId}`)}>Resume reconciling</Button>
        ) : (
          <Button disabled={pending || !accountId || !endDate || !balance} onClick={begin}>
            Start reconciling
          </Button>
        )}
      </div>
    </div>
  );
}
