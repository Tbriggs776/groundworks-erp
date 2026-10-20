import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { salesFormData } from "@/lib/ui/form-data";
import { SalesDocForm } from "../../sales-doc-form";

export default async function NewSalesReceiptPage({ searchParams }: { searchParams: Promise<{ customerId?: string }> }) {
  const { customerId } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  await requireActor("bookkeeper");
  const data = await salesFormData(organization.id);
  return (
    <AppShell title="New Sales Receipt" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <SalesDocForm
        kind="sales_receipt"
        customers={data.customers}
        items={data.items}
        incomeAccounts={data.incomeAccounts}
        taxRates={data.taxRates}
        depositAccounts={data.depositAccounts}
        defaultCustomerId={customerId}
      />
    </AppShell>
  );
}
