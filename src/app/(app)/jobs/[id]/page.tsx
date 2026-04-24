import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
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

  const [customerRows, contractTypeRows, pmRows] = await Promise.all([
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
