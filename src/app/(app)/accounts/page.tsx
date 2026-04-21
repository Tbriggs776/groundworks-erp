import { asc, eq, isNull, and } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { AccountsClient } from "./accounts-client";

export default async function AccountsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organization.id),
        isNull(accounts.deletedAt)
      )
    )
    .orderBy(asc(accounts.code));

  return (
    <AppShell
      title="Chart of Accounts"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <AccountsClient accounts={rows} />
    </AppShell>
  );
}
