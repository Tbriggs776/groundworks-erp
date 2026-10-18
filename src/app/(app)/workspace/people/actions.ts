"use server";

import { revalidatePath } from "next/cache";
import { workspaceAction, type ActionResult } from "@/lib/action";
import type { Role, WorkspaceRole } from "@/lib/actor";
import { requireWorkspaceActor } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { appOrigin } from "@/lib/ui/origin";
import { inviteAndEmail, type InviteOutcome } from "@/lib/workspace/invite";
import * as ws from "@/lib/workspace/service";

/** People page actions: thin wrappers over src/lib/workspace/service.ts. */

const done = <T extends { ok: boolean }>(r: T) => {
  if (r.ok) revalidatePath("/workspace/people");
  return r;
};

export async function invitePerson(input: ws.InviteInput): Promise<ActionResult<InviteOutcome>> {
  const actor = await requireWorkspaceActor("admin");
  try {
    const outcome = await inviteAndEmail(actor, input, await appOrigin());
    revalidatePath("/workspace/people");
    return { ok: true, ...outcome };
  } catch (err) {
    const e = toAppError(err);
    return { ok: false, error: e.message, code: e.code };
  }
}

export async function revokeInvite(id: string): Promise<ActionResult> {
  return done(await workspaceAction("admin", (ctx) => ws.revokeInvitation(ctx, { id })));
}

export async function setWorkspaceRole(userId: string, role: WorkspaceRole): Promise<ActionResult> {
  return done(
    await workspaceAction("admin", async (ctx) => ({ id: (await ws.updatePerson(ctx, { userId, role })).userId }))
  );
}

export async function setPersonActive(userId: string, isActive: boolean): Promise<ActionResult> {
  return done(
    await workspaceAction("admin", async (ctx) => ({ id: (await ws.updatePerson(ctx, { userId, isActive })).userId }))
  );
}

export async function setAccess(userId: string, organizationId: string, role: Role | null): Promise<ActionResult> {
  return done(
    await workspaceAction("admin", async (ctx) => {
      await ws.setCompanyAccess(ctx, { userId, organizationId, role });
      return { id: userId };
    })
  );
}
