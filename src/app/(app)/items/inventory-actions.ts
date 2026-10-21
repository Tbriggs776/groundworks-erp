"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as adjustments from "@/lib/inventory/adjustments";
import * as stock from "@/lib/inventory/stock";

/** Inventory server actions: wrappers over src/lib/inventory. */

export type AdjustmentInput = adjustments.CreateInventoryAdjustmentInput;

export async function createAdjustment(input: AdjustmentInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await adjustments.createInventoryAdjustment(ctx, input)).id,
  }));
  if (r.ok) revalidatePath("/items", "layout");
  return r;
}

export async function voidAdjustment(adjustmentId: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await adjustments.voidInventoryAdjustment(ctx, { id: adjustmentId, reason })).id,
  }));
  if (r.ok) revalidatePath("/items", "layout");
  return r;
}

export async function setCostingMethod(costingMethod: "fifo" | "average" | "specific"): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => {
    await stock.updateInventorySettings(ctx, { costingMethod });
    return { id: ctx.actor.organizationId };
  });
  if (r.ok) revalidatePath("/settings/inventory");
  return r;
}
