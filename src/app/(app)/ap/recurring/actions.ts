"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as recurring from "@/lib/ap/recurring-bills";

/** Recurring bill server actions: thin wrappers over src/lib/ap/recurring-bills.ts. */

function revalidate() {
  revalidatePath("/ap", "layout");
  revalidatePath("/review");
  revalidatePath("/dashboard");
}

export type RecurringBillFormInput = Omit<recurring.CreateRecurringBillInput, "startDate"> & { date?: string };

export async function saveRecurringBill(templateId: string | null, input: RecurringBillFormInput): Promise<ActionResult> {
  const { date, ...rest } = input;
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const t = templateId
      ? await recurring.updateRecurringBill(ctx, { ...rest, id: templateId, nextRunDate: date })
      : await recurring.createRecurringBill(ctx, { ...rest, startDate: date });
    return { id: t.id };
  });
  if (r.ok) revalidate();
  return r;
}

export async function setRecurringBillStatus(id: string, status: "active" | "paused"): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await recurring.setRecurringBillStatus(ctx, { id, status })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function deleteRecurringBill(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => recurring.deleteRecurringBill(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}

/** Returns the new bill's id. */
export async function billFromTemplate(id: string, billDate: string, submit: boolean): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await recurring.createBillFromRecurring(ctx, { id, billDate, submit })).id }));
  if (r.ok) revalidate();
  return r;
}
