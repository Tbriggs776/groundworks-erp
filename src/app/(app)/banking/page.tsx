import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listBankAccountsOverview } from "@/lib/banking/reconcile";
import { listUndepositedPayments } from "@/lib/banking/transactions";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { NewTransactionLinks, PillLink } from "./ui";

export default async function BankingPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [accounts, undeposited] = await Promise.all([
    runAs(actor, (ctx) => listBankAccountsOverview(ctx)),
    runAs(actor, (ctx) => listUndepositedPayments(ctx)),
  ]);
  const fmt = (v: string) => formatMoney(v, { currency: organization.baseCurrency });
  const waiting = accounts.reduce((n, a) => n + a.forReview, 0);
  const undepositedTotal = sumMoney(undeposited.map((p) => p.amount));

  return (
    <AppShell title="Bank Accounts" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <div className="space-y-5 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground max-w-xl">
            Import a statement, review each line (match it to what&apos;s in the books, or add it), then reconcile.
            {waiting > 0 && <> <span className="text-foreground font-medium">{waiting} line{waiting === 1 ? "" : "s"}</span> waiting for review.</>}
          </p>
          <NewTransactionLinks />
        </div>

        {accounts.length === 0 && (
          <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
            No bank or credit card accounts yet. Add one in the{" "}
            <Link href="/accounts" className="text-primary hover:underline">chart of accounts</Link> and mark it for reconciliation.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {accounts.map((a) => {
            const card = a.normalBalance === "credit";
            const gap = money(a.bookBalance).minus(money(a.clearedBalance));
            return (
              <div key={a.id} className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{a.code} · {card ? "Credit card" : "Bank"}</div>
                    <div className="font-semibold truncate">{a.name}</div>
                  </div>
                  {a.forReview > 0 && (
                    <Link
                      href={`/banking/review?account=${a.id}`}
                      className="shrink-0 rounded-full bg-[var(--gw-gold)]/15 text-[var(--gw-gold-deep)] px-2 py-0.5 text-[11px] font-semibold hover:underline"
                    >
                      {a.forReview} for review
                    </Link>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{card ? "Owed (books)" : "In the books"}</div>
                    <div className="font-mono text-lg">{fmt(a.bookBalance)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cleared</div>
                    <div className="font-mono text-lg">{fmt(a.clearedBalance)}</div>
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground space-y-0.5">
                  {a.lastImport?.ledgerBalance && (
                    <div>
                      Bank says {fmt(a.lastImport.ledgerBalance)}
                      {a.lastImport.ledgerBalanceDate ? ` as of ${a.lastImport.ledgerBalanceDate}` : ""}
                    </div>
                  )}
                  {!gap.isZero() && <div>{fmt(gap.toFixed(4))} not yet cleared</div>}
                  <div>
                    {a.lastReconciled
                      ? `Reconciled through ${a.lastReconciled.date} (${fmt(a.lastReconciled.balance)})`
                      : "Never reconciled"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <PillLink href={`/banking/review?account=${a.id}`}>For review</PillLink>
                  <PillLink href={`/banking/register?account=${a.id}`}>Register</PillLink>
                  <PillLink href={a.inProgressReconciliationId ? `/banking/reconcile/${a.inProgressReconciliationId}` : `/banking/reconcile?account=${a.id}`}>
                    {a.inProgressReconciliationId ? "Resume reconcile" : "Reconcile"}
                  </PillLink>
                </div>
              </div>
            );
          })}
        </div>

        {undeposited.length > 0 && (
          <div className="rounded-md border border-border px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-semibold">{undeposited.length} payment{undeposited.length === 1 ? "" : "s"}</span> ({fmt(undepositedTotal.toFixed(4))}) waiting in Undeposited Funds.
              <div className="text-[11px] text-muted-foreground">Group them into a deposit so the books match the bank statement.</div>
            </div>
            <PillLink href="/banking/transactions/new?type=deposit" primary>Make a deposit</PillLink>
          </div>
        )}
      </div>
    </AppShell>
  );
}
