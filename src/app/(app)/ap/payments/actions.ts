"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as billPayments from "@/lib/ap/bill-payments";

/**
 * Bill payment server actions — thin wrappers over
 * src/lib/ap/bill-payments.ts.
 */

export type PaymentInput = Omit<billPayments.CreateBillPaymentInput, "post">;
export type { ActionResult };

function revalidate(paymentId?: string) {
  revalidatePath("/ap/payments");
  if (paymentId) revalidatePath(`/ap/payments/${paymentId}`);
  revalidatePath("/ap/bills");
  revalidatePath("/gl");
}

export async function createPayment(input: PaymentInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await billPayments.createBillPayment(ctx, input)).id,
  }));
  if (r.ok) revalidate(r.id);
  return r;
}

export async function postPayment(paymentId: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({
    id: (await billPayments.postBillPayment(ctx, { id: paymentId })).id,
  }));
  if (r.ok) revalidate(paymentId);
  return r;
}

export async function voidPayment(
  paymentId: string,
  reason: string
): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await billPayments.voidBillPayment(ctx, { id: paymentId, reason })).id,
  }));
  if (r.ok) revalidate(paymentId);
  return r;
}
