import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { changeOrders, jobs } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { getJobChangeOrderSummary } from "@/lib/projects/change-orders";

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

export default async function ChangeOrdersListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.organizationId, organization.id)));
  if (!job) notFound();

  const [rows, summary] = await Promise.all([
    db
      .select()
      .from(changeOrders)
      .where(
        and(
          eq(changeOrders.organizationId, organization.id),
          eq(changeOrders.jobId, id)
        )
      )
      .orderBy(desc(changeOrders.createdAt)),
    getJobChangeOrderSummary(organization.id, id),
  ]);

  return (
    <AppShell
      title={`Change Orders — ${job.code}`}
      crumb={`${organization.name} · Projects · Jobs · ${job.code}`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-6xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {job.code} — Change Orders
            </div>
            <div className="text-sm mt-1 text-muted-foreground">{job.name}</div>
          </div>
          <Link
            href={`/jobs/${id}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to job
          </Link>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-4 gap-3">
          <Tile label="Total COs" value={String(summary.totalCount)} />
          <Tile label="Executed" value={String(summary.executedCount)} accent />
          <Tile
            label="Pending"
            value={String(summary.pendingCount + summary.rejectedCount)}
            muted
          />
          <Tile
            label="Live contract Δ"
            money={summary.liveContractDelta}
            warn={Number(summary.liveContractDelta) < 0}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rows.length} change order{rows.length === 1 ? "" : "s"} on this
            job.
          </div>
          {job.status !== "closed" && (
            <Link
              href={`/jobs/${id}/change-orders/new`}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              New CO
            </Link>
          )}
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">CO #</th>
                <th className="text-left font-medium px-3 py-2 w-28">Ext ref</th>
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
                    No change orders yet.
                  </td>
                </tr>
              )}
              {rows.map((co) => {
                const adj = Number(co.contractAdjustment);
                return (
                  <tr key={co.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/jobs/${id}/change-orders/${co.id}`}
                        className="text-primary hover:underline"
                      >
                        {co.coNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {co.externalReference ?? "—"}
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

function Tile({
  label,
  value,
  money,
  accent,
  muted,
  warn,
}: {
  label: string;
  value?: string;
  money?: string;
  accent?: boolean;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
        {label}
      </div>
      <div
        className={`font-mono text-lg ${
          warn
            ? "text-destructive"
            : accent
              ? "text-primary"
              : muted
                ? "text-muted-foreground"
                : "text-foreground"
        }`}
      >
        {money !== undefined ? formatMoney(money) : value}
      </div>
    </div>
  );
}
