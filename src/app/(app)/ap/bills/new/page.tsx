import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  commitmentLines,
  commitments,
  costCodes,
  jobs,
  vendors,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { BillForm, type CommitmentLineOption } from "../bill-form";

export default async function NewBillPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [vendorRows, acctRows, jobRows, costCodeRows, coLineRows] =
    await Promise.all([
      db
        .select()
        .from(vendors)
        .where(
          and(
            eq(vendors.organizationId, organization.id),
            eq(vendors.isActive, true),
            isNull(vendors.deletedAt)
          )
        )
        .orderBy(asc(vendors.code)),
      db
        .select()
        .from(accounts)
        .where(eq(accounts.organizationId, organization.id))
        .orderBy(asc(accounts.code)),
      db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organization.id),
            eq(jobs.isActive, true),
            isNull(jobs.deletedAt)
          )
        )
        .orderBy(asc(jobs.code)),
      db
        .select()
        .from(costCodes)
        .where(
          and(
            eq(costCodes.organizationId, organization.id),
            eq(costCodes.isActive, true),
            isNull(costCodes.deletedAt)
          )
        )
        .orderBy(asc(costCodes.code)),
      db
        .select({
          id: commitmentLines.id,
          commitmentId: commitments.id,
          commitmentNumber: commitments.commitmentNumber,
          type: commitments.type,
          vendorId: commitments.vendorId,
          jobId: commitments.jobId,
          costCodeId: commitmentLines.costCodeId,
          accountId: commitmentLines.accountId,
          amount: commitmentLines.amount,
          invoicedAmount: commitmentLines.invoicedAmount,
          description: commitmentLines.description,
        })
        .from(commitmentLines)
        .innerJoin(
          commitments,
          eq(commitments.id, commitmentLines.commitmentId)
        )
        .where(
          and(
            eq(commitments.organizationId, organization.id),
            eq(commitments.status, "issued")
          )
        ),
    ]);

  const coLines: CommitmentLineOption[] = coLineRows.map((r) => ({
    id: r.id,
    commitmentId: r.commitmentId,
    commitmentNumber: r.commitmentNumber,
    type: r.type,
    vendorId: r.vendorId,
    jobId: r.jobId,
    costCodeId: r.costCodeId,
    accountId: r.accountId,
    amount: r.amount,
    invoicedAmount: r.invoicedAmount,
    description: r.description,
  }));

  return (
    <AppShell
      title="New AP Bill"
      crumb={`${organization.name} · Procurement`}
      userEmail={user?.email}
    >
      <BillForm
        vendors={vendorRows}
        accounts={acctRows}
        jobs={jobRows}
        costCodes={costCodeRows}
        commitmentLines={coLines}
      />
    </AppShell>
  );
}
