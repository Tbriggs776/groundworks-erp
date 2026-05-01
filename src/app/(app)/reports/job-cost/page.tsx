import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";
import { getJobsCostSummary } from "@/lib/projects/job-cost";
import { JobCostReportFilter } from "./filter";

type SP = Promise<{ includeClosed?: string }>;

export default async function JobCostReportPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const includeClosed = params.includeClosed === "1";

  const rows = await getJobsCostSummary(organization.id, { includeClosed });

  const totalContract = rows.reduce(
    (a, r) => a.plus(r.contractAmount),
    money(0)
  );
  const totalBudget = rows.reduce((a, r) => a.plus(r.totalBudget), money(0));
  const totalActual = rows.reduce((a, r) => a.plus(r.totalActual), money(0));
  const totalCommitted = rows.reduce(
    (a, r) => a.plus(r.totalCommitted),
    money(0)
  );
  const totalEgp = totalContract.minus(totalActual);

  return (
    <AppShell
      title="Job Cost"
      crumb={`${organization.name} · Reports`}
      userEmail={user?.email}
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl tracking-[0.08em] text-foreground">
              JOB COST
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Budget vs actual across active jobs. Actuals roll up live from
              posted GL entries tagged with a job and cost code.
            </p>
          </div>
          <JobCostReportFilter includeClosed={includeClosed} />
        </div>

        {/* Roll-up tiles */}
        <div className="grid grid-cols-5 gap-3">
          <Tile label="Contract value" value={totalContract.toFixed(4)} />
          <Tile label="Total budget" value={totalBudget.toFixed(4)} />
          <Tile label="Committed" value={totalCommitted.toFixed(4)} muted />
          <Tile label="Actual to date" value={totalActual.toFixed(4)} accent />
          <Tile
            label="Est. gross profit"
            value={totalEgp.toFixed(4)}
            warn={totalEgp.isNegative()}
          />
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Job</th>
                <th className="text-left font-medium px-3 py-2">Name</th>
                <th className="text-left font-medium px-3 py-2 w-32">Status</th>
                <th className="text-right font-medium px-3 py-2 w-32">Contract</th>
                <th className="text-right font-medium px-3 py-2 w-32">Budget</th>
                <th className="text-right font-medium px-3 py-2 w-32">Actual</th>
                <th className="text-right font-medium px-3 py-2 w-32">
                  Open Budget
                </th>
                <th className="text-right font-medium px-3 py-2 w-20">% Used</th>
                <th className="text-right font-medium px-3 py-2 w-32">EGP</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No jobs to report.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const open = Number(r.totalOpenBudget);
                const egp = Number(r.estimatedGrossProfit);
                return (
                  <tr key={r.jobId} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/jobs/${r.jobId}`}
                        className="text-primary hover:underline"
                      >
                        {r.jobCode}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div>{r.jobName}</div>
                      {r.customerName && (
                        <div className="text-[10px] text-muted-foreground">
                          {r.customerName}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant="secondary"
                        className="text-[9px] capitalize"
                      >
                        {r.jobStatus.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {formatMoney(r.contractAmount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatMoney(r.totalBudget)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatMoney(r.totalActual)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        open < 0 ? "text-destructive" : ""
                      }`}
                    >
                      {formatMoney(r.totalOpenBudget)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {r.percentUsed === null
                        ? "—"
                        : `${r.percentUsed.toFixed(1)}%`}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        egp < 0 ? "text-destructive" : "text-foreground"
                      }`}
                    >
                      {formatMoney(r.estimatedGrossProfit)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="bg-muted/30 border-t-2 border-border">
                  <td
                    colSpan={3}
                    className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold"
                  >
                    Totals — {rows.length} {rows.length === 1 ? "job" : "jobs"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                    {formatMoney(totalContract.toFixed(4))}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                    {formatMoney(totalBudget.toFixed(4))}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                    {formatMoney(totalActual.toFixed(4))}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs font-semibold ${
                      totalBudget.minus(totalActual).isNegative()
                        ? "text-destructive"
                        : ""
                    }`}
                  >
                    {formatMoney(
                      totalBudget.minus(totalCommitted).minus(totalActual).toFixed(4)
                    )}
                  </td>
                  <td className="px-3 py-2"></td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs font-semibold ${
                      totalEgp.isNegative() ? "text-destructive" : ""
                    }`}
                  >
                    {formatMoney(totalEgp.toFixed(4))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </AppShell>
  );
}

function Tile({
  label,
  value,
  muted,
  accent,
  warn,
}: {
  label: string;
  value: string;
  muted?: boolean;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
        {label}
      </div>
      <div
        className={`font-mono text-base ${
          warn
            ? "text-destructive"
            : accent
              ? "text-primary"
              : muted
                ? "text-muted-foreground"
                : "text-foreground"
        }`}
      >
        {formatMoney(value)}
      </div>
    </div>
  );
}
