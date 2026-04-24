import { asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { contractTypes } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { ContractTypesClient } from "./contract-types-client";

export default async function ContractTypesPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select()
    .from(contractTypes)
    .where(eq(contractTypes.organizationId, organization.id))
    .orderBy(asc(contractTypes.sortOrder), asc(contractTypes.name));

  return (
    <AppShell
      title="Contract Types"
      crumb={`${organization.name} · Settings`}
      userEmail={user?.email}
    >
      <ContractTypesClient types={rows} />
    </AppShell>
  );
}
