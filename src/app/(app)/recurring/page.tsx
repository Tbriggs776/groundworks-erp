import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { Plus } from "lucide-react";
import { db } from "@/lib/db/client";
import { recurringJournals } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { RunNowButton } from "./run-now-button";

export default async function RecurringPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select()
    .from(recurringJournals)
    .where(
      and(
        eq(recurringJournals.organizationId, organization.id),
        isNull(recurringJournals.deletedAt)
      )
    )
    .orderBy(desc(recurringJournals.updatedAt));

  return (
    <AppShell
      title="Recurring Journals"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rows.length} recurring entries. The daily cron runs at 06:00 UTC;
            you can also run them on-demand.
          </div>
          <div className="flex gap-2">
            <RunNowButton />
            <Link
              href="/recurring/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              New recurring
            </Link>
          </div>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-36">Code</th>
                <th className="text-left font-medium px-3 py-2">Name</th>
                <th className="text-left font-medium px-3 py-2 w-28">Frequency</th>
                <th className="text-left font-medium px-3 py-2 w-32">Next run</th>
                <th className="text-left font-medium px-3 py-2 w-32">Last run</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No recurring journals yet. Create one to schedule automated
                    JE generation.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/recurring/${r.id}`}
                      className="text-primary hover:underline"
                    >
                      {r.code}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground capitalize">
                    {r.frequency.replace(/_/g, " ")}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.nextRunDate}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {r.lastRunDate ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
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
  if (status === "active")
    return (
      <Badge variant="default" className="text-[9px]">
        Active
      </Badge>
    );
  if (status === "paused")
    return (
      <Badge variant="secondary" className="text-[9px]">
        Paused
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-[9px]">
      Ended
    </Badge>
  );
}
