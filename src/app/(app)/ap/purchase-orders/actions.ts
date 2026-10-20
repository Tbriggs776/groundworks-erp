"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as pos from "@/lib/ap/purchase-orders";

/** Purchase order server actions: thin wrappers over src/lib/ap/purchase-orders.ts. */

function revalidate() {
  revalidatePath("/ap", "layout");
  revalidatePath("/vendors");
  revalidatePath("/review");
  revalidatePath("/dashboard");
}

export async function savePurchaseOrder(poId: string | null, input: Omit<pos.CreatePurchaseOrderInput, "submit">, submit: boolean): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    let po = poId ? await pos.updatePurchaseOrder(ctx, { ...input, id: poId }) : await pos.createPurchaseOrder(ctx, input);
    if (submit) po = await pos.submitPurchaseOrder(ctx, { id: po.id });
    return { id: po.id };
  });
  if (r.ok) revalidate();
  return r;
}

export type PoStep = "submit" | "approve" | "sent" | "reopen" | "delete";

export async function purchaseOrderStep(step: PoStep, id: string): Promise<ActionResult> {
  const r = await serviceAction(step === "approve" ? "accountant" : "bookkeeper", async (ctx) => {
    if (step === "submit") await pos.submitPurchaseOrder(ctx, { id });
    if (step === "approve") await pos.approvePurchaseOrder(ctx, { id });
    if (step === "sent") await pos.markPurchaseOrderSent(ctx, { id });
    if (step === "reopen") await pos.reopenPurchaseOrder(ctx, { id });
    if (step === "delete") await pos.deleteDraftPurchaseOrder(ctx, { id });
    return { id };
  });
  if (r.ok) revalidate();
  return r;
}

export async function purchaseOrderWithReason(step: "reject" | "close", id: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction(step === "reject" ? "accountant" : "bookkeeper", async (ctx) => {
    if (step === "reject") await pos.rejectPurchaseOrder(ctx, { id, reason });
    else await pos.closePurchaseOrder(ctx, { id, reason });
    return { id };
  });
  if (r.ok) revalidate();
  return r;
}

/** Partial billing: returns the new draft bill's id. */
export async function billPurchaseOrder(input: pos.CreateBillFromPurchaseOrderInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await pos.createBillFromPurchaseOrder(ctx, input)).id,
  }));
  if (r.ok) revalidate();
  return r;
}
