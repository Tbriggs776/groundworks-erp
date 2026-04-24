import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { employees, memberships, profiles } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { EmployeesClient } from "./employees-client";

export default async function EmployeesPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  // Employees + joined linked user (if any)
  const rawEmployees = await db
    .select({
      employee: employees,
      linkedUser: {
        id: profiles.id,
        email: profiles.email,
        fullName: profiles.fullName,
      },
    })
    .from(employees)
    .leftJoin(profiles, eq(profiles.id, employees.userId))
    .where(
      and(
        eq(employees.organizationId, organization.id),
        isNull(employees.deletedAt)
      )
    )
    .orderBy(asc(employees.code));

  const employeeRows = rawEmployees.map((r) => ({
    ...r.employee,
    linkedUser: r.linkedUser?.id ? r.linkedUser : null,
  }));

  // Users with an ACTIVE membership in this org — the pool of candidates
  // for linking. Employees UI further narrows this to users not already
  // linked to a different employee record.
  const linkableUsers = await db
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
    .orderBy(asc(profiles.email));

  return (
    <AppShell
      title="Employees"
      crumb={`${organization.name} · People`}
      userEmail={user?.email}
    >
      <EmployeesClient
        employees={employeeRows}
        linkableUsers={linkableUsers}
      />
    </AppShell>
  );
}
