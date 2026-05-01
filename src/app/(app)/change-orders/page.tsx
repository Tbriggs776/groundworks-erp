import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { changeOrders, jobs } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { ChangeOrderStatusFilter } from "./filter";

const STATUS_STYLE: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "outline",
  pending_approval: "secondary",
  rejected: "destructive",
  approved: "secondary",
  executed: "default",
  voided: "outline",
};

const ALL_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "executed",
  "rejected",
  "voided",
] as const;

type SP = Promise<{ status?: string | string[] }>;

export default async function ChangeOrdersInboxPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  // Parse the status filter — defaults to actionable states.
  const requested = Array.isArray(params.status)
    ? params.status
    : params.status
      ? [params.status]
      : null;
  const validStatuses = (ALL_STATUSES as readonly string[]).filter((s) =>
    requested ? requested.includes(s) : true
  );
  const defaultActionable = ["draft", "pending_approval", "approved"];
  const activeFilter = requested === null ? defaultActionable : validStatuses;

  const rows = await db
    .select({
      co: changeOrders,
      job: jobs,
    })
    .from(changeOrders)
    .innerJoin(jobs, eq(jobs.id, changeOrders.jobId))
    .where(
      and(
        eq(changeOrders.organizationId, organization.id),
        activeFilter.length > 0
          ? inArray(
              changeOrders.status,
              activeFilter as Array<
                | "draft"
                | "pending_approval"
                | "rejected"
                | "approved"
                | "executed"
                | "voided"
              >
            )
          : undefined
      )
    )
    .orderBy(desc(changeOrders.createdAt));

  return (
    <AppShell
      title="Change Orders"
      crumb={`${organization.name} · Projects`}
      userEmail={user?.email}
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl tracking-[0.08em] text-foreground">
              CHANGE ORDERS
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Cross-job inbox. Approvers see everything pending; PMs use
              this to track active work.
            </p>
          </div>
          <ChangeOrderStatusFilter activeFilter={activeFilter} />
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">CO #</th>
                <th className="text-left font-medium px-3 py-2 w-28">Job</th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-36">
                  Contract Δ
                </th>
                <th className="text-right font-medium px-3 py-2 w-24">Days</th>
                <th className="text-left font-medium px-3 py-2 w-32">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No change orders match this filter.
                  </td>
                </tr>
              )}
              {rows.map(({ co, job }) => {
                const adj = Number(co.contractAdjustment);
                return (
                  <tr key={co.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/jobs/${job.id}/change-orders/${co.id}`}
                        className="text-primary hover:underline"
                      >
                        {co.coNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/jobs/${job.id}`}
                        className="text-primary hover:underline"
                      >
                        {job.code}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{co.description}</td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        adj < 0 ? "text-destructive" : ""
                      }`}
                    >
                      {formatMoney(co.contractAdjustment)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {co.scheduleAdjustmentDays || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={STATUS_STYLE[co.status] ?? "outline"}
                        className="text-[9px] capitalize"
                      >
                        {co.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
