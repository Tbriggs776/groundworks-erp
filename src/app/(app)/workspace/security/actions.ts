"use server";

import { revalidatePath } from "next/cache";
import { workspaceAction, type ActionResult } from "@/lib/action";
import * as ws from "@/lib/workspace/service";

export async function savePolicy(input: ws.SecurityPolicyInput): Promise<ActionResult> {
  const r = await workspaceAction("admin", async (ctx) => {
    await ws.updateSecurityPolicy(ctx, input);
    return { id: ctx.actor.workspaceId };
  });
  if (r.ok) revalidatePath("/workspace/security");
  return r;
}
