"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as invoices from "@/lib/ar/invoices";

/** Invoice server actions — wrappers over src/lib/ar/invoices.ts. */

export type InvoiceInput = Omit<invoices.CreateInvoiceInput, "post">;
export type { ActionResult };

function revalidate(invoiceId?: string) {
  revalidatePath("/ar/invoices");
  if (invoiceId) revalidatePath(`/ar/invoices/${invoiceId}`);
  revalidatePath("/customers");
  revalidatePath("/review");
}

export async function saveInvoice(
  invoiceId: string | null,
  input: InvoiceInput,
  post: boolean
): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const inv = invoiceId
      ? await invoices.updateInvoice(ctx, { ...input, id: invoiceId })
      : await invoices.createInvoice(ctx, input);
    if (post) await invoices.postInvoice(ctx, { id: inv.id });
    return { id: inv.id };
  });
  if (r.ok) revalidate(r.id);
  return r;
}

export async function postInvoice(invoiceId: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await invoices.postInvoice(ctx, { id: invoiceId })).id,
  }));
  if (r.ok) revalidate(invoiceId);
  return r;
}

export async function voidInvoice(invoiceId: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await invoices.voidInvoice(ctx, { id: invoiceId, reason })).id,
  }));
  if (r.ok) revalidate(invoiceId);
  return r;
}

export async function deleteInvoice(invoiceId: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) =>
    invoices.deleteDraftInvoice(ctx, { id: invoiceId })
  );
  if (r.ok) revalidate();
  return r;
}
