"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import { listInvoices } from "@/lib/ar/invoices";
import * as payments from "@/lib/ar/payments";

/** Customer payment server actions — wrappers over src/lib/ar/payments.ts. */

export type ReceivePaymentInput = payments.CreateCustomerPaymentInput;
export type { ActionResult };

function revalidate(paymentId?: string) {
  revalidatePath("/ar/payments");
  if (paymentId) revalidatePath(`/ar/payments/${paymentId}`);
  revalidatePath("/ar/invoices");
  revalidatePath("/customers");
  revalidatePath("/gl");
}

export async function receivePayment(input: ReceivePaymentInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await payments.createCustomerPayment(ctx, input)).id,
  }));
  if (r.ok) revalidate(r.id);
  return r;
}

export async function postCustomerPayment(paymentId: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await payments.postCustomerPayment(ctx, { id: paymentId })).id,
  }));
  if (r.ok) revalidate(paymentId);
  return r;
}

export async function voidCustomerPayment(paymentId: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await payments.voidCustomerPayment(ctx, { id: paymentId, reason })).id,
  }));
  if (r.ok) revalidate(paymentId);
  return r;
}

export async function deleteCustomerPayment(paymentId: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) =>
    payments.deleteDraftCustomerPayment(ctx, { id: paymentId })
  );
  if (r.ok) revalidate();
  return r;
}

export type OpenInvoice = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: string;
  openBalance: string;
};

/** Open invoices for one customer, oldest due first, for the apply grid. */
export async function openInvoicesFor(
  customerId: string
): Promise<ActionResult<{ invoices: OpenInvoice[] }>> {
  return serviceAction("viewer", async (ctx) => {
    const page = await listInvoices(ctx, { customerId, status: "open", limit: 200 });
    return {
      invoices: page.data
        .map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          invoiceDate: i.invoiceDate,
          dueDate: i.dueDate,
          totalAmount: i.totalAmount,
          openBalance: i.openBalance,
        }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    };
  });
}
