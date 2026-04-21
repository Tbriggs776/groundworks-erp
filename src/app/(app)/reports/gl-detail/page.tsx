import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { getGlDetail } from "@/lib/gl/reports";
import { formatMoney, money } from "@/lib/money";
import { GlDetailFilter } from "./filter";

type SP = Promise<{ account?: string; from?: string; to?: string }>;

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const ytdStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return { from: ytdStart, to: today };
}

export default async function GlDetailPage({ searchParams }: { searchParams: SP }) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const defaults = defaultRange();
  const fromDate =
    params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from) ? params.from : defaults.from;
  const toDate =
    params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? params.to : defaults.to;

  const acctRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.organizationId, organization.id))
    .orderBy(asc(accounts.code));

  const accountId = params.account || "";
  const selected = acctRows.find((a) => a.id === accountId) ?? null;

  const detail = selected
    ? await getGlDetail(organization.id, {
        accountId: selected.id,
        fromDate,
        toDate,
      })
    : null;

  const totalDebit = detail?.rows.reduce((a, r) => a.plus(r.debit), money(0)) ?? money(0);
  const totalCredit = detail?.rows.reduce((a, r) => a.plus(r.credit), money(0)) ?? money(0);

  return (
    <AppShell
      title="GL Detail"
      crumb={`${organization.name} · Reports`}
      userEmail={user?.email}
    >
      <div className="space-y-5">
        <GlDetailFilter
          accounts={acctRows}
          accountId={accountId}
          fromDate={fromDate}
          toDate={toDate}
        />

        {!selected && (
          <div className="text-sm text-muted-foreground">
            Pick an account to see its activity.
          </div>
        )}

        {selected && detail && (
          <>
            <div>
              <div className="font-heading text-2xl tracking-[0.1em]">
                {selected.code} — {selected.name}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {fromDate} to {toDate} · opening balance:{" "}
                <span className="font-mono text-foreground">
                  {formatMoney(
                    selected.normalBalance === "debit"
                      ? detail.opening
                      : detail.opening.neg()
                  )}
                </span>
              </div>
            </div>

            <div className="rounded-md border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                    <th className="text-left font-medium px-3 py-2 w-32">Journal</th>
                    <th className="text-left font-medium px-3 py-2 w-24">Period</th>
                    <th className="text-left font-medium px-3 py-2">Description / Memo</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Debit</th>
                    <th className="text-right font-medium px-3 py-2 w-28">Credit</th>
                    <th className="text-right font-medium px-3 py-2 w-32">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-3 py-10 text-center text-xs text-muted-foreground"
                      >
                        No activity on this account in the selected range.
                      </td>
                    </tr>
                  )}
                  {detail.rows.map((r) => {
                    const displayBal =
                      selected.normalBalance === "debit"
                        ? r.runningBalance
                        : r.runningBalance.neg();
                    return (
                      <tr key={r.lineId} className="border-t border-border">
                        <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                          {r.journalDate}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs">
                          <Link
                            href={`/gl/${r.journalId}`}
                            className="text-primary hover:underline"
                          >
                            {r.journalNumber}
                          </Link>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                          {r.periodCode}
                        </td>
                        <td className="px-3 py-1.5 text-xs">
                          {r.description}
                          {r.memo && (
                            <span className="text-muted-foreground ml-2">
                              · {r.memo}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-xs">
                          {r.debit.gt(0) ? formatMoney(r.debit) : ""}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-xs">
                          {r.credit.gt(0) ? formatMoney(r.credit) : ""}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-xs">
                          {formatMoney(displayBal)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/30 border-t-2 border-border">
                    <td
                      colSpan={4}
                      className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                    >
                      Totals
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatMoney(totalDebit)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatMoney(totalCredit)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
