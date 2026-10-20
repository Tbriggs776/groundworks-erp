import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getEstimate } from "@/lib/ar/estimates";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { salesFormData } from "@/lib/ui/form-data";
import { SalesDocForm } from "../../../sales-doc-form";

export default async function EditEstimatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const e = await runAs(actor, (ctx) => getEstimate(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  if (e.invoiceCount > 0 || e.status === "closed") {
    return (
      <AppShell title="Edit not allowed" crumb={`${organization.name} · Sales · Estimates`} userEmail={user?.email}>
        <p className="text-sm text-muted-foreground">
          {e.status === "closed"
            ? "This estimate is closed. Reopen it to edit."
            : "This estimate has invoices, so its lines are fixed. Void or delete those invoices first, or make a new estimate."}
        </p>
      </AppShell>
    );
  }
  const data = await salesFormData(organization.id);
  return (
    <AppShell title={`Edit ${e.estimateNumber}`} crumb={`${organization.name} · Sales · Estimates`} userEmail={user?.email}>
      <SalesDocForm
        kind="estimate"
        customers={data.customers}
        items={data.items}
        incomeAccounts={data.incomeAccounts}
        taxRates={data.taxRates}
        initial={{
          id: e.id,
          customerId: e.customerId,
          date: e.estimateDate,
          dueDate: e.expirationDate,
          taxCodeId: e.taxCodeId,
          memo: e.memo,
          privateNote: e.privateNote,
        }}
        initialLines={e.lines}
      />
    </AppShell>
  );
}
