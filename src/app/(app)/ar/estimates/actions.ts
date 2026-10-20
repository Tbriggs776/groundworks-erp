"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as estimates from "@/lib/ar/estimates";

/** Estimate server actions: thin wrappers over src/lib/ar/estimates.ts. */

function revalidate() {
  revalidatePath("/ar", "layout");
  revalidatePath("/customers");
  revalidatePath("/review");
  revalidatePath("/dashboard");
}

export async function saveEstimate(estimateId: string | null, input: estimates.CreateEstimateInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const e = estimateId
      ? await estimates.updateEstimate(ctx, { ...input, id: estimateId })
      : await estimates.createEstimate(ctx, input);
    return { id: e.id };
  });
  if (r.ok) revalidate();
  return r;
}

export async function setEstimateStatus(
  id: string,
  status: (typeof estimates.ESTIMATE_STATUSES)[number],
  acceptedBy?: string
): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await estimates.setEstimateStatus(ctx, { id, status, acceptedBy })).id,
  }));
  if (r.ok) revalidate();
  return r;
}

export async function deleteEstimate(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => estimates.deleteEstimate(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}

/** Progress invoicing: returns the new draft invoice's id. */
export async function invoiceEstimate(input: estimates.CreateInvoiceFromEstimateInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await estimates.createInvoiceFromEstimate(ctx, input)).id,
  }));
  if (r.ok) revalidate();
  return r;
}
