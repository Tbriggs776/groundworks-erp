import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db/client";
import {
  contractTypes,
  customers,
  jobs,
  memberships,
  profiles,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { getJobCostSummary } from "@/lib/projects/job-cost";
import { getJobChangeOrderSummary } from "@/lib/projects/change-orders";
import { JobStatusActions } from "./status-actions";
import { JobForm } from "../job-form";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [result] = await db
    .select({
      job: jobs,
      customer: customers,
      contractType: contractTypes,
    })
    .from(jobs)
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(contractTypes, eq(contractTypes.id, jobs.contractTypeId))
    .where(
      and(eq(jobs.id, id), eq(jobs.organizationId, organization.id))
    );
  if (!result) notFound();

  const [customerRows, contractTypeRows, pmRows, summary, coSummary] =
    await Promise.all([
      db
        .select()
        .from(customers)
        .where(eq(customers.organizationId, organization.id))
        .orderBy(asc(customers.code)),
      db
        .select()
        .from(contractTypes)
        .where(eq(contractTypes.organizationId, organization.id))
        .orderBy(asc(contractTypes.sortOrder)),
      db
        .select({
          id: profiles.id,
          email: profiles.email,
          fullName: profiles.fullName,
        })
        .from(profiles)
        .innerJoin(memberships, eq(memberships.userId, profiles.id))
        .where(
          and(
            eq(memberships.organizationId, organization.id),
            eq(memberships.isActive, true)
          )
        ),
      getJobCostSummary(organization.id, id),
      getJobChangeOrderSummary(organization.id, id),
    ]);

  const { job, customer, contractType } = result;

  return (
    <AppShell
      title={`${job.code} — ${job.name}`}
      crumb={`${organization.name} · Projects · Jobs`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {job.code}
            </div>
            <h1 className="text-lg mt-1">{job.name}</h1>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-3">
              <span>
                Customer:{" "}
                <span className="text-foreground">{customer.name}</span>
              </span>
              {contractType && (
                <>
                  <span>·</span>
                  <span>Contract: {contractType.name}</span>
                </>
              )}
              <span>·</span>
              <span>
                Value:{" "}
                <span className="font-mono text-foreground">
                  {formatMoney(job.contractAmount)}
                </span>
              </span>
              <span>·</span>
              <Badge variant="secondary" className="text-[9px] capitalize">
                {job.status.replace(/_/g, " ")}
              </Badge>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <JobStatusActions job={job} />
            <Link
              href="/jobs"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back to list
            </Link>
          </div>
        </div>

        {/* Change Orders summary strip */}
        <div className="rounded-md border border-border bg-card p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <div>
              <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
                Change Orders
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span>
                  <span className="font-mono text-foreground">
                    {coSummary.executedCount}
                  </span>{" "}
                  <span className="text-muted-foreground">executed</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="font-mono text-foreground">
                    {coSummary.pendingCount}
                  </span>{" "}
                  <span className="text-muted-foreground">pending</span>
                </span>
                {coSummary.rejectedCount > 0 && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span>
                      <span className="font-mono text-destructive">
                        {coSummary.rejectedCount}
                      </span>{" "}
                      <span className="text-muted-foreground">rejected</span>
                    </span>
                  </>
                )}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
                Live contract Δ
              </div>
              <div
                className={`font-mono text-base ${
                  Number(coSummary.liveContractDelta) < 0
                    ? "text-destructive"
                    : Number(coSummary.liveContractDelta) > 0
                      ? "text-primary"
                      : "text-muted-foreground"
                }`}
              >
                {formatMoney(coSummary.liveContractDelta)}
              </div>
            </div>
          </div>
          <Link
            href={`/jobs/${id}/change-orders`}
            className="text-xs text-primary hover:underline"
          >
            View all →
          </Link>
        </div>

        {summary && (
          <div className="rounded-md border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold">
                Job Cost — Budget vs Actual
              </div>
              <Link
                href={`/jobs/${id}/budget`}
                className="text-xs text-primary hover:underline"
              >
                Manage budget →
              </Link>
            </div>

            <div className="grid grid-cols-5 gap-3">
              <Tile label="Contract" value={summary.contractAmount} />
              <Tile label="Budget" value={summary.totalBudget} />
              <Tile
                label="Actual"
                value={summary.totalActual}
                accent
              />
              <Tile
                label="Open budget"
                value={summary.totalOpenBudget}
                warn={Number(summary.totalOpenBudget) < 0}
              />
              <Tile
                label="Est. gross profit"
                value={summary.estimatedGrossProfit}
                warn={Number(summary.estimatedGrossProfit) < 0}
              />
            </div>

            {summary.unbudgetedCount > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                <span className="font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                  {summary.unbudgetedCount} unbudgeted{" "}
                  {summary.unbudgetedCount === 1 ? "code" : "codes"}
                </span>
                {" — "}
                actuals posted against {summary.unbudgetedCount === 1 ? "a cost code" : "cost codes"} not on the
                job&apos;s budget. Review on the budget page and either add a budget
                line or reclassify the GL entry.
              </div>
            )}

            {summary.rows.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted-foreground">
                No budget set yet.{" "}
                <Link
                  href={`/jobs/${id}/budget`}
                  className="text-primary hover:underline"
                >
                  Set up the cost-code budget →
                </Link>
              </div>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left font-medium px-3 py-2 w-28">Code</th>
                      <th className="text-left font-medium px-3 py-2">Name</th>
                      <th className="text-right font-medium px-3 py-2 w-32">Budget</th>
                      <th className="text-right font-medium px-3 py-2 w-32">Actual</th>
                      <th className="text-right font-medium px-3 py-2 w-32">Variance</th>
                      <th className="text-right font-medium px-3 py-2 w-20">% Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.map((r) => {
                      const variance = Number(r.variance);
                      return (
                        <tr
                          key={`${r.jobCostCodeId ?? "u"}-${r.costCodeId}`}
                          className={`border-t border-border ${
                            r.unbudgeted ? "bg-amber-500/5" : ""
                          }`}
                        >
                          <td className="px-3 py-2 font-mono text-xs">
                            {r.costCode}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {r.costCodeName}
                            {r.unbudgeted && (
                              <Badge
                                variant="secondary"
                                className="ml-2 text-[8px] uppercase tracking-wider"
                              >
                                unbudgeted
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs">
                            {formatMoney(r.budget)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs">
                            {formatMoney(r.actual)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right font-mono text-xs ${
                              variance < 0 ? "text-destructive" : ""
                            }`}
                          >
                            {formatMoney(r.variance)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                            {r.percentUsed === null
                              ? "—"
                              : `${r.percentUsed.toFixed(1)}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end">
              <Link href={`/jobs/${id}/budget`}>
                <Button size="sm" variant="ghost">
                  Open budget editor
                </Button>
              </Link>
            </div>
          </div>
        )}

        <div className="rounded-md border border-border p-5 bg-card">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-3 font-semibold">
            Edit details
          </div>
          <JobForm
            customers={customerRows}
            contractTypes={contractTypeRows}
            projectManagers={pmRows}
            initial={job}
          />
        </div>
      </div>
    </AppShell>
  );
}

function Tile({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
        {label}
      </div>
      <div
        className={`font-mono text-base ${
          warn
            ? "text-destructive"
            : accent
              ? "text-primary"
              : "text-foreground"
        }`}
      >
        {formatMoney(value)}
      </div>
    </div>
  );
}
