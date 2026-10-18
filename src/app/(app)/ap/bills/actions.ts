"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as bills from "@/lib/ap/bills";

/**
 * Bill server actions — thin wrappers over src/lib/ap/bills.ts, which owns
 * validation, the state machine, approval routing, and the audit trail for
 * the web UI, REST API, and MCP server alike.
 */

export type BillInput = Omit<bills.CreateBillInput, "submit">;

function revalidate(billId?: string) {
  revalidatePath("/ap/bills");
  if (billId) revalidatePath(`/ap/bills/${billId}`);
  revalidatePath("/gl");
  revalidatePath("/review");
}

export async function createBill(input: BillInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await bills.createBill(ctx, input)).id,
  }));
  if (r.ok) revalidate(r.id);
  return r;
}

export async function updateBill(
  billId: string,
  input: BillInput
): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await bills.updateBill(ctx, { ...input, id: billId })).id,
  }));
  if (r.ok) revalidate(billId);
  return r;
}

export async function submitForApproval(billId: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await bills.submitBill(ctx, { id: billId })).id,
  }));
  if (r.ok) revalidate(billId);
  return r;
}

export async function approveBill(billId: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({
    id: (await bills.approveBill(ctx, { id: billId })).id,
  }));
  if (r.ok) revalidate(billId);
  return r;
}

export async function rejectBill(
  billId: string,
  reason: string
): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({
    id: (await bills.rejectBill(ctx, { id: billId, reason })).id,
  }));
  if (r.ok) revalidate(billId);
  return r;
}

export async function postBill(billId: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({
    id: (await bills.postBill(ctx, { id: billId })).id,
  }));
  if (r.ok) revalidate(billId);
  return r;
}

export async function voidBill(
  billId: string,
  reason: string
): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await bills.voidBill(ctx, { id: billId, reason })).id,
  }));
  if (r.ok) revalidate(billId);
  return r;
}

export async function previewApprovalRouting(amount: string): Promise<{
  requiredRole: string;
  tierName: string | null;
  fallback: boolean;
}> {
  const r = await serviceAction("viewer", (ctx) =>
    bills.previewBillApproval(ctx, { amount })
  );
  if (!r.ok) return { requiredRole: "admin", tierName: null, fallback: true };
  return {
    requiredRole: r.requiredRole,
    tierName: r.tierName,
    fallback: r.fallback,
  };
}
