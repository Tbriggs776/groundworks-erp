"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as parties from "@/lib/parties/service";

/** Vendor server actions — thin wrappers over src/lib/parties/service.ts. */

export type VendorInput = parties.CreateVendorInput;

export async function createVendor(input: VendorInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await parties.createVendor(ctx, input)).id,
  }));
  if (r.ok) revalidatePath("/vendors");
  return r;
}

export async function updateVendor(
  vendorId: string,
  input: VendorInput
): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await parties.updateVendor(ctx, { ...input, id: vendorId })).id,
  }));
  if (r.ok) revalidatePath("/vendors");
  return r;
}
