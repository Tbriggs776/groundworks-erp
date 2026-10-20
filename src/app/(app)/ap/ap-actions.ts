"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as checks from "@/lib/ap/checks";
import * as credits from "@/lib/ap/credits";
import * as vendorCredits from "@/lib/ap/vendor-credits";
import * as vendorRefunds from "@/lib/ap/vendor-refunds";

/**
 * Server actions for vendor credits, vendor refunds, credit applications,
 * and printed checks: thin wrappers over src/lib/ap/*.
 */

function revalidate() {
  revalidatePath("/ap", "layout");
  revalidatePath("/vendors");
  revalidatePath("/review");
  revalidatePath("/banking", "layout");
  revalidatePath("/dashboard");
}

type Saved = ActionResult<{ id: string; review?: { required: true; reason: string } }>;
export type ApDocKind = "vendor_credit" | "vendor_refund";

export async function saveVendorCredit(input: Omit<vendorCredits.CreateVendorCreditInput, "post">, post: boolean): Promise<Saved> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const d = await vendorCredits.createVendorCredit(ctx, { ...input, post });
    return { id: d.id, review: d.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function saveVendorRefund(input: Omit<vendorRefunds.CreateVendorRefundInput, "post">, post: boolean): Promise<Saved> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const d = await vendorRefunds.createVendorRefund(ctx, { ...input, post });
    return { id: d.id, review: d.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function postApDoc(kind: ApDocKind, id: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({
    id: kind === "vendor_credit" ? (await vendorCredits.postVendorCredit(ctx, { id })).id : (await vendorRefunds.postVendorRefund(ctx, { id })).id,
  }));
  if (r.ok) revalidate();
  return r;
}

export async function voidApDoc(kind: ApDocKind, id: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id:
      kind === "vendor_credit"
        ? (await vendorCredits.voidVendorCredit(ctx, { id, reason })).id
        : (await vendorRefunds.voidVendorRefund(ctx, { id, reason })).id,
  }));
  if (r.ok) revalidate();
  return r;
}

export async function deleteApDoc(kind: ApDocKind, id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) =>
    kind === "vendor_credit" ? vendorCredits.deleteDraftVendorCredit(ctx, { id }) : vendorRefunds.deleteDraftVendorRefund(ctx, { id })
  );
  if (r.ok) revalidate();
  return r;
}

export async function applyVendorCredit(input: { vendorCreditId: string; billId: string; amount?: string }): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await credits.applyVendorCredit(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function unapplyVendorCredit(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => credits.unapplyVendorCredit(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}

export async function vendorCreditsFor(vendorId: string): Promise<ActionResult<{ id: string; credits: credits.VendorCreditBalance[] }>> {
  return serviceAction("viewer", async (ctx) => ({ id: vendorId, credits: await credits.listVendorCreditsAvailable(ctx, { vendorId }) }));
}

/** Number the checks and take them out of the queue; the PDF opens from the returned link. */
export async function printQueuedChecks(input: {
  bankAccountId: string;
  firstCheckNumber: number;
  checks: Array<{ kind: checks.CheckKind; id: string }>;
}): Promise<ActionResult<{ id: string; printed: Array<{ kind: checks.CheckKind; id: string; checkNumber: string }>; nextCheckNumber: number }>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const p = await checks.printChecks(ctx, input);
    return { id: input.bankAccountId, printed: p.checks, nextCheckNumber: p.nextCheckNumber };
  });
  if (r.ok) revalidate();
  return r;
}

export async function queueCheckAgain(kind: checks.CheckKind, id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    await checks.queueCheck(ctx, { kind, id });
    return { id };
  });
  if (r.ok) revalidate();
  return r;
}
