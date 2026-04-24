import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  contractTypes,
  customers,
  memberships,
  profiles,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { JobForm } from "../job-form";

export default async function NewJobPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [customerRows, contractTypeRows, pmRows] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, organization.id),
          eq(customers.isActive, true),
          isNull(customers.deletedAt)
        )
      )
      .orderBy(asc(customers.code)),
    db
      .select()
      .from(contractTypes)
      .where(eq(contractTypes.organizationId, organization.id))
      .orderBy(asc(contractTypes.sortOrder), asc(contractTypes.name)),
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
      )
      .orderBy(asc(profiles.email)),
  ]);

  return (
    <AppShell
      title="New Job"
      crumb={`${organization.name} · Projects`}
      userEmail={user?.email}
    >
      <JobForm
        customers={customerRows}
        contractTypes={contractTypeRows}
        projectManagers={pmRows}
      />
    </AppShell>
  );
}
