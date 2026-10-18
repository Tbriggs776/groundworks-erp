import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { salesFormData } from "@/lib/ui/form-data";
import { InvoiceForm } from "../invoice-form";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const { customerId } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const data = await salesFormData(organization.id);

  return (
    <AppShell title="New Invoice" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <InvoiceForm
        customers={data.customers}
        items={data.items}
        incomeAccounts={data.incomeAccounts}
        defaultCustomerId={customerId}
      />
    </AppShell>
  );
}
