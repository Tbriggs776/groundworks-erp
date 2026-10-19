import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { salesFormData } from "@/lib/ui/form-data";
import { ReceivePaymentForm } from "./receive-payment-form";

export default async function ReceivePaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; invoiceId?: string }>;
}) {
  const { customerId, invoiceId } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const data = await salesFormData(organization.id);

  return (
    <AppShell title="Receive Payment" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <ReceivePaymentForm
        customers={data.customers}
        depositAccounts={data.depositAccounts}
        defaultCustomerId={customerId}
        defaultInvoiceId={invoiceId}
      />
    </AppShell>
  );
}
