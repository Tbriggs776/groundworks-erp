import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { dimensions, dimensionValues } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { DimensionsClient } from "./dimensions-client";

export default async function DimensionsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [dimRows, valueRows] = await Promise.all([
    db
      .select()
      .from(dimensions)
      .where(
        and(
          eq(dimensions.organizationId, organization.id),
          isNull(dimensions.deletedAt)
        )
      )
      .orderBy(asc(dimensions.sortOrder), asc(dimensions.code)),
    db
      .select()
      .from(dimensionValues)
      .where(
        and(
          eq(dimensionValues.organizationId, organization.id),
          isNull(dimensionValues.deletedAt)
        )
      )
      .orderBy(asc(dimensionValues.sortOrder), asc(dimensionValues.code)),
  ]);

  return (
    <AppShell
      title="Dimensions"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <DimensionsClient dimensions={dimRows} values={valueRows} />
    </AppShell>
  );
}
