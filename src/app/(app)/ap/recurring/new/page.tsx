import { AppShell } from "@/components/app-shell/shell";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { purchaseFormData } from "@/lib/ui/form-data";
import { RecurringBillForm } from "../recurring-bill-form";

export default async function NewRecurringBillPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  await requireActor("bookkeeper");
  const data = await purchaseFormData(organization.id);
  return (
    <AppShell title="New Recurring Bill" crumb={`${organization.name} · Expenses`} userEmail={user?.email}>
      <RecurringBillForm vendors={data.vendors} accounts={data.accounts} />
    </AppShell>
  );
}
