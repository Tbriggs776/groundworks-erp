import { format } from "date-fns";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { listItems } from "@/lib/ar/items";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { ItemsClient } from "./items-client";

export default async function ItemsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [page, acctRows] = await Promise.all([
    runAs(actor, (ctx) => listItems(ctx, { includeInactive: true, limit: 200 })),
    db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          eq(accounts.accountType, "posting"),
          eq(accounts.isActive, true),
          eq(accounts.isControl, false)
        )
      )
      .orderBy(asc(accounts.code)),
  ]);

  return (
    <AppShell
      title="Products & Services"
      crumb={`${organization.name} · Sales`}
      userEmail={user?.email}
    >
      <ItemsClient items={page.data} accounts={acctRows} today={format(new Date(), "yyyy-MM-dd")} />
    </AppShell>
  );
}
