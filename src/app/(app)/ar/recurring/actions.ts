"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as recurring from "@/lib/ar/recurring-invoices";

/** Recurring invoice server actions: thin wrappers over src/lib/ar/recurring-invoices.ts. */

/** The form's one date is the first invoice's date on create, the next one's on edit. */
export type RecurringFormInput = Omit<recurring.CreateRecurringInvoiceInput, "startDate"> & { date?: string };

function revalidate() {
  revalidatePath("/ar", "layout");
  revalidatePath("/review");
  revalidatePath("/dashboard");
}

export async function saveRecurringInvoice(templateId: string | null, input: RecurringFormInput): Promise<ActionResult> {
  const { date, ...rest } = input;
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const t = templateId
      ? await recurring.updateRecurringInvoice(ctx, { ...rest, id: templateId, nextRunDate: date })
      : await recurring.createRecurringInvoice(ctx, { ...rest, startDate: date });
    return { id: t.id };
  });
  if (r.ok) revalidate();
  return r;
}

export async function setRecurringStatus(id: string, status: "active" | "paused"): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await recurring.setRecurringInvoiceStatus(ctx, { id, status })).id,
  }));
  if (r.ok) revalidate();
  return r;
}

/** Make an invoice from the template now; returns the invoice's id. */
export async function invoiceFromTemplate(id: string, invoiceDate?: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await recurring.createInvoiceFromRecurring(ctx, { id, invoiceDate })).id,
  }));
  if (r.ok) revalidate();
  return r;
}

export async function deleteRecurringInvoice(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => recurring.deleteRecurringInvoice(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}
