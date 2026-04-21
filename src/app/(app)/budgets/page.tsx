import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { budgets, fiscalYears } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";

export default async function BudgetsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select({
      budget: budgets,
      year: fiscalYears,
    })
    .from(budgets)
    .innerJoin(fiscalYears, eq(fiscalYears.id, budgets.fiscalYearId))
    .where(
      and(
        eq(budgets.organizationId, organization.id),
        isNull(budgets.deletedAt)
      )
    )
    .orderBy(desc(budgets.updatedAt));

  return (
    <AppShell
      title="Budgets"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Named budgets per fiscal year. Compare against actuals in the
            Variance report (coming in Chunk E).
          </div>
          <Link
            href="/budgets/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New budget
          </Link>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-36">Code</th>
                <th className="text-left font-medium px-3 py-2">Name</th>
                <th className="text-left font-medium px-3 py-2 w-28">Year</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No budgets yet.
                  </td>
                </tr>
              )}
              {rows.map(({ budget: b, year }) => (
                <tr key={b.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/budgets/${b.id}`}
                      className="text-primary hover:underline"
                    >
                      {b.code}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{b.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {year.yearLabel}
                  </td>
                  <td className="px-3 py-2">
                    {b.isLocked ? (
                      <Badge variant="destructive" className="text-[9px]">
                        Locked
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[9px]">
                        Draft
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
