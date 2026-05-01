import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { costCodes, jobs } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { getJobCostSummary } from "@/lib/projects/job-cost";
import { BudgetEditor } from "./budget-editor";

export default async function JobBudgetPage({
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

  const summary = await getJobCostSummary(organization.id, id);
  if (!summary) notFound();

  const allCostCodes = await db
    .select()
    .from(costCodes)
    .where(
      and(
        eq(costCodes.organizationId, organization.id),
        eq(costCodes.isActive, true)
      )
    )
    .orderBy(asc(costCodes.code));

  return (
    <AppShell
      title={`Budget — ${job.code}`}
      crumb={`${organization.name} · Projects · Jobs · ${job.code}`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-6xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {job.code} — Cost Budget
            </div>
            <h1 className="text-sm mt-1 text-muted-foreground">{job.name}</h1>
          </div>
          <Link
            href={`/jobs/${id}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to job
          </Link>
        </div>

        <BudgetEditor
          jobId={id}
          jobIsClosed={job.status === "closed"}
          rows={summary.rows}
          totalBudget={summary.totalBudget}
          totalActual={summary.totalActual}
          totalCommitted={summary.totalCommitted}
          totalOpenBudget={summary.totalOpenBudget}
          allCostCodes={allCostCodes.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            costType: c.costType,
          }))}
        />
      </div>
    </AppShell>
  );
}
