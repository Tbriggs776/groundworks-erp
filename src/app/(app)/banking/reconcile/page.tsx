import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listBankAccountsOverview, listReconciliations } from "@/lib/banking/reconcile";
import { formatMoney } from "@/lib/money";
import { StartReconciliation } from "./start-form";

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [accounts, history] = await Promise.all([
    runAs(actor, (ctx) => listBankAccountsOverview(ctx)),
    runAs(actor, (ctx) => listReconciliations(ctx, { limit: 100 })),
  ]);
  const fmt = (v: string) => formatMoney(v, { currency: organization.baseCurrency });

  return (
    <AppShell title="Reconcile" crumb={`${organization.name} · Banking`} userEmail={user?.email}>
      <div className="space-y-6 max-w-5xl">
        <StartReconciliation
          accounts={accounts.map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            card: a.normalBalance === "credit",
            lastReconciled: a.lastReconciled,
            inProgressId: a.inProgressReconciliationId,
            bankBalance: a.lastImport?.ledgerBalance ?? null,
            bankBalanceDate: a.lastImport?.ledgerBalanceDate ?? null,
          }))}
          defaultAccountId={sp.account}
          currency={organization.baseCurrency}
        />

        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-2">History</div>
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2">Account</th>
                  <th className="text-left font-medium px-3 py-2 w-32">Statement date</th>
                  <th className="text-right font-medium px-3 py-2 w-36">Ending balance</th>
                  <th className="text-right font-medium px-3 py-2 w-24">Lines</th>
                  <th className="text-left font-medium px-3 py-2 w-32">Status</th>
                  <th className="text-left font-medium px-3 py-2 w-40">Finished</th>
                </tr>
              </thead>
              <tbody>
                {history.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">No reconciliations yet.</td>
                  </tr>
                )}
                {history.data.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link href={`/banking/reconcile/${r.id}`} className="text-primary hover:underline">
                        {r.accountCode} · {r.accountName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.statementEndDate}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmt(r.statementEndingBalance)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{r.status === "completed" ? r.clearedCount : "—"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={r.status === "completed" ? "default" : r.status === "in_progress" ? "secondary" : "outline"} className="text-[9px] capitalize">
                        {r.status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.completedAt ? new Date(r.completedAt).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
