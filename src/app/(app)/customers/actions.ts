"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as parties from "@/lib/parties/service";

/** Customer server actions — thin wrappers over src/lib/parties/service.ts. */

export type CustomerInput = parties.CreateCustomerInput;

export async function createCustomer(input: CustomerInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await parties.createCustomer(ctx, input)).id,
  }));
  if (r.ok) revalidatePath("/customers");
  return r;
}

export async function updateCustomer(
  customerId: string,
  input: CustomerInput
): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await parties.updateCustomer(ctx, { ...input, id: customerId })).id,
  }));
  if (r.ok) revalidatePath("/customers");
  return r;
}
