import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getRecurringInvoice } from "@/lib/ar/recurring-invoices";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { salesFormData } from "@/lib/ui/form-data";
import { SalesDocForm } from "../../../sales-doc-form";

export default async function EditRecurringInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const t = await runAs(actor, (ctx) => getRecurringInvoice(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  const data = await salesFormData(organization.id);
  return (
    <AppShell title={`Edit ${t.name}`} crumb={`${organization.name} · Sales · Recurring Invoices`} userEmail={user?.email}>
      <SalesDocForm
        kind="recurring_invoice"
        customers={data.customers}
        items={data.items}
        incomeAccounts={data.incomeAccounts}
        taxRates={data.taxRates}
        initial={{
          id: t.id,
          customerId: t.customerId,
          date: t.nextRunDate ?? format(new Date(), "yyyy-MM-dd"),
          poNumber: t.poNumber,
          taxCodeId: t.taxCodeId,
          memo: t.memo,
          privateNote: t.privateNote,
          schedule: t,
        }}
        initialLines={t.lines}
      />
    </AppShell>
  );
}
