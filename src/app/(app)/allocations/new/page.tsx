import { asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { AllocationForm } from "../allocation-form";

export default async function NewAllocationPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const acctRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.organizationId, organization.id))
    .orderBy(asc(accounts.code));

  return (
    <AppShell
      title="New Allocation"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <AllocationForm accounts={acctRows} />
    </AppShell>
  );
}
