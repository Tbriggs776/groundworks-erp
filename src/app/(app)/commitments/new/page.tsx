import Link from "next/link";
import { and, asc, eq, ne } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts, costCodes, jobs, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { CommitmentForm } from "../commitment-form";

type SP = Promise<{ jobId?: string }>;

export default async function NewCommitmentPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [jobRows, vendorRows, ccRows, acctRows] = await Promise.all([
    db
      .select({ id: jobs.id, code: jobs.code, name: jobs.name })
      .from(jobs)
      .where(
        and(
          eq(jobs.organizationId, organization.id),
          ne(jobs.status, "closed")
        )
      )
      .orderBy(asc(jobs.code)),
    db
      .select({ id: vendors.id, code: vendors.code, name: vendors.name })
      .from(vendors)
      .where(
        and(
          eq(vendors.organizationId, organization.id),
          eq(vendors.isActive, true)
        )
      )
      .orderBy(asc(vendors.code)),
    db
      .select({ id: costCodes.id, code: costCodes.code, name: costCodes.name })
      .from(costCodes)
      .where(
        and(
          eq(costCodes.organizationId, organization.id),
          eq(costCodes.isActive, true)
        )
      )
      .orderBy(asc(costCodes.code)),
    db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          eq(accounts.isActive, true),
          eq(accounts.directPosting, true),
          eq(accounts.accountType, "posting")
        )
      )
      .orderBy(asc(accounts.code)),
  ]);

  return (
    <AppShell
      title="New Commitment"
      crumb={`${organization.name} · Projects`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              New Commitment
            </div>
            <div className="text-sm mt-1 text-muted-foreground">
              Purchase order or subcontract — locks in scope before any bills
              come in.
            </div>
          </div>
          <Link
            href="/commitments"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to inbox
          </Link>
        </div>

        <div className="rounded-md border border-border p-5 bg-card">
          <CommitmentForm
            presetJobId={params.jobId}
            jobs={jobRows}
            vendors={vendorRows}
            accounts={acctRows}
            costCodes={ccRows}
          />
        </div>
      </div>
    </AppShell>
  );
}
