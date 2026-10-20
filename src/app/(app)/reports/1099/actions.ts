"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as form1099 from "@/lib/ap/form-1099";

/** Map an expense account to a 1099 box (or clear it). */
export async function setAccountBox(accountId: string, box: form1099.Form1099Box | null): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await form1099.setAccount1099Box(ctx, { id: accountId, box })).id }));
  if (r.ok) revalidatePath("/reports/1099");
  return r;
}
