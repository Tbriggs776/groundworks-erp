import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts, items, vendors } from "@/lib/db/schema";
import { lotChoices } from "@/lib/ui/form-data";
import { toPurchaseItems } from "@/app/(app)/_inventory/purchase-items";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { VendorCreditForm } from "../credit-form";

export default async function NewVendorCreditPage({ searchParams }: { searchParams: Promise<{ vendorId?: string }> }) {
  const { vendorId } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  await requireActor("bookkeeper");
  const [vendorRows, acctRows, itemRows, lots] = await Promise.all([
    db
      .select()
      .from(vendors)
      .where(and(eq(vendors.organizationId, organization.id), eq(vendors.isActive, true), isNull(vendors.deletedAt)))
      .orderBy(asc(vendors.name)),
    db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          eq(accounts.accountType, "posting"),
          eq(accounts.isActive, true),
          eq(accounts.isBlocked, false),
          eq(accounts.directPosting, true)
        )
      )
      .orderBy(asc(accounts.code)),
    db
      .select()
      .from(items)
      .where(and(eq(items.organizationId, organization.id), eq(items.isActive, true), isNull(items.deletedAt)))
      .orderBy(asc(items.name)),
    lotChoices(organization.id),
  ]);
  return (
    <AppShell title="New Vendor Credit" crumb={`${organization.name} · Expenses`} userEmail={user?.email}>
      <VendorCreditForm
        vendors={vendorRows}
        accounts={acctRows.filter((a) => !a.isControl)}
        items={toPurchaseItems(itemRows)}
        lots={lots}
        defaultVendorId={vendorId}
      />
    </AppShell>
  );
}
