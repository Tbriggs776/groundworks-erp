import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getInvoice } from "@/lib/ar/invoices";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { salesFormData } from "@/lib/ui/form-data";
import { InvoiceForm } from "../../invoice-form";

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const invoice = await runAs(actor, (ctx) => getInvoice(ctx, { id })).catch((e) => {
    if (toAppError(e).code === "not_found" || toAppError(e).code === "invalid_input") notFound();
    throw e;
  });
  if (invoice.status !== "draft") {
    return (
      <AppShell title="Edit not allowed" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
        <p className="text-sm text-muted-foreground">
          A {invoice.status} invoice can&apos;t be edited. Void it and issue a new one.
        </p>
      </AppShell>
    );
  }
  const data = await salesFormData(organization.id);

  return (
    <AppShell
      title={`Edit ${invoice.invoiceNumber}`}
      crumb={`${organization.name} · Sales · Invoices`}
      userEmail={user?.email}
    >
      <InvoiceForm
        customers={data.customers}
        items={data.items}
        incomeAccounts={data.incomeAccounts}
        initial={invoice}
        initialLines={invoice.lines}
      />
    </AppShell>
  );
}
