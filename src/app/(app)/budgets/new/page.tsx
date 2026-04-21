import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { fiscalYears } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { NewBudgetForm } from "./new-budget-form";

export default async function NewBudgetPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const years = await db
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.organizationId, organization.id),
        isNull(fiscalYears.deletedAt)
      )
    )
    .orderBy(asc(fiscalYears.startDate));

  return (
    <AppShell
      title="New Budget"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <NewBudgetForm fiscalYears={years} />
    </AppShell>
  );
}
