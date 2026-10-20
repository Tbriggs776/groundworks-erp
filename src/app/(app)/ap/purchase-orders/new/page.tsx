import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { purchaseFormData } from "@/lib/ui/form-data";
import { PurchaseOrderForm } from "../po-form";

export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: Promise<{ vendorId?: string }> }) {
  const { vendorId } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  await requireActor("bookkeeper");
  const data = await purchaseFormData(organization.id);
  return (
    <AppShell title="New Purchase Order" crumb={`${organization.name} · Expenses`} userEmail={user?.email}>
      <PurchaseOrderForm {...data} defaultVendorId={vendorId} />
    </AppShell>
  );
}
