import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getRecurringBill } from "@/lib/ap/recurring-bills";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { purchaseFormData } from "@/lib/ui/form-data";
import { RecurringBillForm } from "../../recurring-bill-form";

export default async function EditRecurringBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const t = await runAs(actor, (ctx) => getRecurringBill(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  const data = await purchaseFormData(organization.id);
  return (
    <AppShell title={`Edit ${t.name}`} crumb={`${organization.name} · Expenses · Recurring Bills`} userEmail={user?.email}>
      <RecurringBillForm vendors={data.vendors} accounts={data.accounts} initial={t} initialLines={t.lines} />
    </AppShell>
  );
}
