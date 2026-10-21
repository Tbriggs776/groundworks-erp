import { format } from "date-fns";
import { and, asc, eq, ne } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { listItems } from "@/lib/ar/items";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { AdjustmentForm } from "./adjustment-form";

export default async function NewInventoryAdjustmentPage({ searchParams }: { searchParams: Promise<{ itemId?: string }> }) {
  const { itemId } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const [page, acctRows] = await Promise.all([
    runAs(actor, (ctx) => listItems(ctx, { type: "inventory", limit: 200 })),
    db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, category: accounts.category, subcategory: accounts.subcategory })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          eq(accounts.accountType, "posting"),
          eq(accounts.isActive, true),
          eq(accounts.isControl, false),
          ne(accounts.subcategory, "inventory")
        )
      )
      .orderBy(asc(accounts.code)),
  ]);
  return (
    <AppShell title="New Inventory Adjustment" crumb={`${organization.name} · Sales · Inventory Adjustments`} userEmail={user?.email}>
      <AdjustmentForm items={page.data} accounts={acctRows} today={format(new Date(), "yyyy-MM-dd")} presetItemId={itemId} />
    </AppShell>
  );
}
