import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { getTrialBalance } from "@/lib/gl/reports";
import { formatMoney, money } from "@/lib/money";
import { TrialBalanceFilter } from "./filter";

type SP = Promise<{ asOf?: string; includeZero?: string }>;

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const asOfDate =
    params.asOf && /^\d{4}-\d{2}-\d{2}$/.test(params.asOf)
      ? params.asOf
      : new Date().toISOString().slice(0, 10);
  const includeZero = params.includeZero === "1";

  const rows = await getTrialBalance(organization.id, { asOfDate, includeZero });

  const totalDebit = rows.reduce((a, r) => a.plus(r.totalDebit), money(0));
  const totalCredit = rows.reduce((a, r) => a.plus(r.totalCredit), money(0));
  const diff = totalDebit.minus(totalCredit);
  const balanced = diff.isZero();

  return (
    <AppShell
      title="Trial Balance"
      crumb={`${organization.name} · Reports`}
      userEmail={user?.email}
    >
      <div className="space-y-5">
        <TrialBalanceFilter asOfDate={asOfDate} includeZero={includeZero} />

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-24">Code</th>
                <th className="text-left font-medium px-3 py-2">Name</th>
                <th className="text-left font-medium px-3 py-2 w-40">Subcategory</th>
                <th className="text-right font-medium px-3 py-2 w-36">Debit</th>
                <th className="text-right font-medium px-3 py-2 w-36">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No activity through {asOfDate}.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const isDebit = r.netDebit.gt(0);
                const abs = r.netDebit.abs();
                return (
                  <tr key={r.accountId} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs text-primary">
                      {r.code}
                    </td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.subcategory.replace(/_/g, " ")}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {isDebit && !abs.isZero() ? formatMoney(abs) : ""}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {!isDebit && !abs.isZero() ? formatMoney(abs) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted/30 border-t-2 border-border">
                <td></td>
                <td
                  className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                  colSpan={2}
                >
                  Totals
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(totalDebit)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(totalCredit)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex items-center justify-end gap-3">
          {balanced ? (
            <span className="text-xs uppercase tracking-wider text-[var(--gw-green-bright)]">
              ✓ Balanced
            </span>
          ) : (
            <span className="text-xs uppercase tracking-wider text-destructive">
              OUT OF BALANCE: Δ {formatMoney(diff.abs())}
            </span>
          )}
        </div>
      </div>
    </AppShell>
  );
}
