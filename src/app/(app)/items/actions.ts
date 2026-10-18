"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as items from "@/lib/ar/items";

/** Products & services server actions — wrappers over src/lib/ar/items.ts. */

export type ItemInput = items.CreateItemInput;

export async function createItem(input: ItemInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await items.createItem(ctx, input)).id,
  }));
  if (r.ok) revalidatePath("/items");
  return r;
}

export async function updateItem(itemId: string, input: ItemInput): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: (await items.updateItem(ctx, { ...input, id: itemId })).id,
  }));
  if (r.ok) revalidatePath("/items");
  return r;
}
