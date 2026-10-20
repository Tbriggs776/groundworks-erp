import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getInvoice } from "@/lib/ar/invoices";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { salesFormData } from "@/lib/ui/form-data";
import { SalesDocForm, type SalesDocInitial, type SalesDocInitialLine } from "../../sales-doc-form";

export default async function NewRecurringInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; fromInvoice?: string }>;
}) {
  const { customerId, fromInvoice } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const data = await salesFormData(organization.id);

  // "Make recurring" from an invoice: start from its customer, lines, and tax rate.
  let initialLines: SalesDocInitialLine[] | undefined;
  let prefill: Partial<SalesDocInitial> = {};
  if (fromInvoice) {
    const inv = await runAs(actor, (ctx) => getInvoice(ctx, { id: fromInvoice })).catch(() => null);
    if (inv) {
      initialLines = inv.lines;
      prefill = { customerId: inv.customerId, taxCodeId: inv.taxCodeId, memo: inv.memo, privateNote: inv.privateNote, poNumber: inv.poNumber };
    }
  }

  return (
    <AppShell title="New Recurring Invoice" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <SalesDocForm
        key={fromInvoice ?? "blank"}
        kind="recurring_invoice"
        customers={data.customers}
        items={data.items}
        incomeAccounts={data.incomeAccounts}
        taxRates={data.taxRates}
        defaultCustomerId={prefill.customerId ?? customerId}
        initialLines={initialLines}
        prefill={prefill}
      />
    </AppShell>
  );
}
