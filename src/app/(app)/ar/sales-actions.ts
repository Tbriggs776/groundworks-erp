"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as credits from "@/lib/ar/credits";
import * as memos from "@/lib/ar/credit-memos";
import * as refunds from "@/lib/ar/refunds";
import * as receipts from "@/lib/ar/sales-receipts";
import * as settings from "@/lib/ar/settings";

/**
 * Server actions for sales receipts, credit memos, refunds, and customer
 * credits: thin wrappers over src/lib/ar/*.
 */

function revalidate() {
  revalidatePath("/ar", "layout");
  revalidatePath("/customers");
  revalidatePath("/review");
  revalidatePath("/banking", "layout");
  revalidatePath("/sales-tax");
  revalidatePath("/dashboard");
}

type Saved = ActionResult<{ id: string; review?: { required: true; reason: string } }>;

export async function saveSalesReceipt(input: Omit<receipts.CreateSalesReceiptInput, "post">, post: boolean): Promise<Saved> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const d = await receipts.createSalesReceipt(ctx, { ...input, post });
    return { id: d.id, review: d.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function saveCreditMemo(input: Omit<memos.CreateCreditMemoInput, "post">, post: boolean): Promise<Saved> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const d = await memos.createCreditMemo(ctx, { ...input, post });
    return { id: d.id, review: d.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function saveRefund(input: refunds.CreateRefundInput, post: boolean): Promise<Saved> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const d = await refunds.createRefund(ctx, { ...input, post });
    return { id: d.id, review: d.review };
  });
  if (r.ok) revalidate();
  return r;
}

export type SalesDocKind = "sales_receipt" | "credit_memo" | "refund";

export async function postSalesDoc(kind: SalesDocKind, id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    if (kind === "sales_receipt") return { id: (await receipts.postSalesReceipt(ctx, { id })).id };
    if (kind === "credit_memo") return { id: (await memos.postCreditMemo(ctx, { id })).id };
    return { id: (await refunds.postRefund(ctx, { id })).id };
  });
  if (r.ok) revalidate();
  return r;
}

export async function voidSalesDoc(kind: SalesDocKind, id: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => {
    if (kind === "sales_receipt") return { id: (await receipts.voidSalesReceipt(ctx, { id, reason })).id };
    if (kind === "credit_memo") return { id: (await memos.voidCreditMemo(ctx, { id, reason })).id };
    return { id: (await refunds.voidRefund(ctx, { id, reason })).id };
  });
  if (r.ok) revalidate();
  return r;
}

export async function deleteSalesDoc(kind: SalesDocKind, id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => {
    if (kind === "sales_receipt") return receipts.deleteDraftSalesReceipt(ctx, { id });
    if (kind === "credit_memo") return memos.deleteDraftCreditMemo(ctx, { id });
    return refunds.deleteDraftRefund(ctx, { id });
  });
  if (r.ok) revalidate();
  return r;
}

export async function customerCredits(customerId: string): Promise<ActionResult<{ id: string; credits: credits.CustomerCredit[] }>> {
  return serviceAction("viewer", async (ctx) => ({ id: customerId, credits: await credits.listCustomerCredits(ctx, { customerId }) }));
}

export async function applyCredit(input: { creditMemoId?: string; paymentId?: string; invoiceId: string; amount?: string }): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await credits.applyCredit(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function unapplyCredit(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => credits.unapplyCredit(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}

export async function setAutoApplyCredits(on: boolean): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => {
    await settings.updateSalesSettings(ctx, { autoApplyCredits: on });
    return { id: ctx.actor.organizationId };
  });
  if (r.ok) revalidatePath("/settings/sales");
  return r;
}
