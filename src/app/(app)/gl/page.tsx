import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { Plus } from "lucide-react";
import { db } from "@/lib/db/client";
import { fiscalPeriods, glJournals, glLines } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";

export default async function GlPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  // Pull recent journals + their period info + debit totals
  const journals = await db
    .select({
      id: glJournals.id,
      journalNumber: glJournals.journalNumber,
      journalDate: glJournals.journalDate,
      source: glJournals.source,
      description: glJournals.description,
      status: glJournals.status,
      periodCode: fiscalPeriods.periodCode,
      totalDebit: sql<string>`COALESCE((SELECT SUM(debit_local) FROM ${glLines} WHERE journal_id = ${glJournals.id}), 0)::text`,
    })
    .from(glJournals)
    .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, glJournals.periodId))
    .where(eq(glJournals.organizationId, organization.id))
    .orderBy(desc(glJournals.journalDate), desc(glJournals.createdAt))
    .limit(100);

  return (
    <AppShell
      title="General Ledger"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Recent journals (last 100)
          </div>
          <Link
            href="/gl/journals/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New Journal Entry
          </Link>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-32">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2 w-28">Period</th>
                <th className="text-left font-medium px-3 py-2 w-32">Source</th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-32">Debit total</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {journals.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-xs text-muted-foreground">
                    No journals yet. Create your first one.
                  </td>
                </tr>
              )}
              {journals.map((j) => (
                <tr
                  key={j.id}
                  className="border-t border-border hover:bg-accent/30"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/gl/${j.id}`}
                      className="text-primary hover:underline"
                    >
                      {j.journalNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {j.journalDate}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {j.periodCode}
                  </td>
                  <td className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                    {j.source}
                  </td>
                  <td className="px-3 py-2 text-sm">{j.description}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(j.totalDebit)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={j.status} />
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

function StatusBadge({ status }: { status: string }) {
  const style: Record<string, "outline" | "secondary" | "destructive" | "default"> = {
    draft: "outline",
    pending_approval: "outline",
    posted: "default",
    reversed: "secondary",
  };
  const label: Record<string, string> = {
    draft: "Draft",
    pending_approval: "Pending",
    posted: "Posted",
    reversed: "Reversed",
  };
  return (
    <Badge variant={style[status] ?? "outline"} className="text-[9px]">
      {label[status] ?? status}
    </Badge>
  );
}
