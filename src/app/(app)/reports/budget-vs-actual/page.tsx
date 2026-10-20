import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { budgetVsActual, reportChoices } from "@/lib/reports/statements";
import { idParam, ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

export default async function BudgetVsActualPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; budgetId?: string }> }) {
  const sp = await searchParams;
  const { from, to } = ytd(sp);
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const choices = await runAs(actor, (ctx) => reportChoices(ctx));
  const budgetId = idParam(sp.budgetId) ?? choices.budgets[0]?.id;
  const table = await runAs(actor, (ctx) => budgetVsActual(ctx, { from, to, budgetId }));
  return (
    <AppShell title="Budget vs Actual" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/budget-vs-actual" from={from} to={to}>
            {choices.budgets.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Budget</div>
                <select name="budgetId" defaultValue={budgetId} className="text-sm bg-background border border-border rounded-md px-2 py-2" aria-label="Budget">
                  {choices.budgets.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}
          </ReportFilters>
          <ExportLinks report="budget-vs-actual" params={{ from, to, budgetId }} />
        </div>
        {choices.budgets.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No budgets yet. <Link href="/budgets/new" className="text-primary hover:underline">Create one</Link> to compare against.
          </p>
        )}
        <ReportTableView table={table} companyName={organization.name} drill={{ from, to }} />
      </div>
    </AppShell>
  );
}
