import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  allocationGroups,
  allocationTargets,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { AllocationForm } from "../allocation-form";

export default async function EditAllocationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [group] = await db
    .select()
    .from(allocationGroups)
    .where(
      and(
        eq(allocationGroups.id, id),
        eq(allocationGroups.organizationId, organization.id)
      )
    );
  if (!group) notFound();

  const [targetRows, acctRows] = await Promise.all([
    db
      .select()
      .from(allocationTargets)
      .where(eq(allocationTargets.allocationGroupId, id))
      .orderBy(asc(allocationTargets.createdAt)),
    db
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, organization.id))
      .orderBy(asc(accounts.code)),
  ]);

  return (
    <AppShell
      title={`Edit ${group.code}`}
      crumb={`${organization.name} · Financials · Allocations`}
      userEmail={user?.email}
    >
      <AllocationForm
        accounts={acctRows}
        initial={{
          id: group.id,
          code: group.code,
          name: group.name,
          description: group.description,
          allocationType: group.allocationType,
          sourceStatisticalAccountId: group.sourceStatisticalAccountId,
          isActive: group.isActive,
          targets: targetRows.map((t) => ({
            accountId: t.accountId,
            percent: t.percent,
            memo: t.memo,
          })),
        }}
      />
    </AppShell>
  );
}
