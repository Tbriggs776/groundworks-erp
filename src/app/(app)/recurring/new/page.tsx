import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { RecurringForm } from "../recurring-form";

export default async function NewRecurringPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const acctRows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.organizationId, organization.id)))
    .orderBy(asc(accounts.code));

  return (
    <AppShell
      title="New Recurring Journal"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <RecurringForm accounts={acctRows} />
    </AppShell>
  );
}
