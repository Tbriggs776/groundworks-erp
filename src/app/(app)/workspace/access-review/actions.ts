"use server";

import { revalidatePath } from "next/cache";
import { workspaceAction, type ActionResult } from "@/lib/action";
import * as ws from "@/lib/workspace/service";

export async function completeReview(notes: string): Promise<ActionResult> {
  const r = await workspaceAction("admin", (ctx) => ws.completeAccessReview(ctx, { notes }));
  if (r.ok) revalidatePath("/workspace/access-review");
  return r;
}
