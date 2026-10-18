"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as team from "@/lib/team/service";
import { appOrigin } from "@/lib/ui/origin";

/** Team server actions — wrappers over src/lib/team/service.ts. */

export async function inviteMember(input: team.InviteInput): Promise<ActionResult<{ link: string }>> {
  const base = await appOrigin();
  const r = await serviceAction("admin", async (ctx) => {
    const { token } = await team.createInvitation(ctx, input);
    return { link: `${base}/invite/${token}` };
  });
  if (r.ok) revalidatePath("/settings/team");
  return r;
}

export async function revokeInvite(invitationId: string): Promise<ActionResult> {
  const r = await serviceAction("admin", (ctx) => team.revokeInvitation(ctx, { id: invitationId }));
  if (r.ok) revalidatePath("/settings/team");
  return r;
}

export async function updateMember(
  membershipId: string,
  patch: { role?: team.MemberRow["role"]; isActive?: boolean }
): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await team.updateMember(ctx, { membershipId, ...patch })).membershipId,
  }));
  if (r.ok) revalidatePath("/settings/team");
  return r;
}
