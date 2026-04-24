import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { costCodes } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { CostCodesClient } from "./cost-codes-client";

export default async function CostCodesPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select()
    .from(costCodes)
    .where(
      and(
        eq(costCodes.organizationId, organization.id),
        isNull(costCodes.deletedAt)
      )
    )
    .orderBy(asc(costCodes.sortOrder), asc(costCodes.code));

  return (
    <AppShell
      title="Cost Codes"
      crumb={`${organization.name} · Projects`}
      userEmail={user?.email}
    >
      <CostCodesClient costCodes={rows} />
    </AppShell>
  );
}
