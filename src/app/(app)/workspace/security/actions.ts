"use server";

import { revalidatePath } from "next/cache";
import { workspaceAction, type ActionResult } from "@/lib/action";
import * as support from "@/lib/security/support";
import * as ws from "@/lib/workspace/service";

export async function savePolicy(input: ws.SecurityPolicyInput): Promise<ActionResult> {
  const r = await workspaceAction("admin", async (ctx) => {
    await ws.updateSecurityPolicy(ctx, input);
    return { id: ctx.actor.workspaceId };
  });
  if (r.ok) revalidatePath("/workspace/security");
  return r;
}

export async function allowSupportAccess(days: number): Promise<ActionResult<{ id: string }>> {
  const r = await workspaceAction("owner", async (ctx) => ({ id: (await support.grantSupportAccess(ctx, { days: days as 1 | 3 | 7 })).id }));
  if (r.ok) revalidatePath("/workspace/security");
  return r;
}

export async function endSupportAccess(): Promise<ActionResult<{ ended: number }>> {
  const r = await workspaceAction("admin", (ctx) => support.revokeSupportAccess(ctx));
  if (r.ok) revalidatePath("/workspace/security");
  return r;
}
