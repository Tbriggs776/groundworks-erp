import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getPurchaseOrder } from "@/lib/ap/purchase-orders";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { purchaseFormData } from "@/lib/ui/form-data";
import { PurchaseOrderForm } from "../../po-form";

export default async function EditPurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const po = await runAs(actor, (ctx) => getPurchaseOrder(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  if (po.status !== "draft" && po.status !== "rejected") redirect(`/ap/purchase-orders/${po.id}`);
  const data = await purchaseFormData(organization.id);
  return (
    <AppShell title={`Edit ${po.poNumber}`} crumb={`${organization.name} · Expenses · Purchase Orders`} userEmail={user?.email}>
      <PurchaseOrderForm {...data} initial={po} initialLines={po.lines} />
    </AppShell>
  );
}
