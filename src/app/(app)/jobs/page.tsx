import Link from "next/link";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { customers, jobs } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";

const STATUS_STYLE: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  bid: "outline",
  awarded: "secondary",
  active: "default",
  on_hold: "secondary",
  closed: "outline",
};

export default async function JobsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select({
      job: jobs,
      customer: customers,
    })
    .from(jobs)
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(
      and(
        eq(jobs.organizationId, organization.id),
        isNull(jobs.deletedAt)
      )
    )
    .orderBy(desc(jobs.updatedAt), asc(jobs.code));

  return (
    <AppShell
      title="Jobs"
      crumb={`${organization.name} · Projects`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rows.length} job{rows.length === 1 ? "" : "s"}.
          </div>
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New job
          </Link>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2">Name</th>
                <th className="text-left font-medium px-3 py-2">Customer</th>
                <th className="text-right font-medium px-3 py-2 w-36">
                  Contract
                </th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No jobs yet. Create one to start tracking budget vs. actual.
                  </td>
                </tr>
              )}
              {rows.map(({ job, customer }) => (
                <tr key={job.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="text-primary hover:underline"
                    >
                      {job.code}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{job.name}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {customer.name}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(job.contractAmount)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={STATUS_STYLE[job.status] ?? "outline"}
                      className="text-[9px] capitalize"
                    >
                      {job.status.replace(/_/g, " ")}
                    </Badge>
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
