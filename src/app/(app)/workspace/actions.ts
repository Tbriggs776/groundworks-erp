"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { workspaceAction, type ActionResult } from "@/lib/action";
import { ACTIVE_ORG_COOKIE, ACTIVE_WORKSPACE_COOKIE, requireWorkspaceActor } from "@/lib/auth";
import { runAsWorkspace } from "@/lib/actor";
import { companyFields, formError, type FormState } from "@/lib/ui/form-state";
import * as ws from "@/lib/workspace/service";

/** Workspace home actions: companies and the workspace name. */

export async function addCompany(_prev: FormState, data: FormData): Promise<FormState> {
  const actor = await requireWorkspaceActor("admin");
  let id: string;
  try {
    ({ id } = await runAsWorkspace(actor, (ctx) => ws.createCompany(ctx, companyFields(data))));
  } catch (err) {
    return formError(err);
  }
  const jar = await cookies();
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 };
  jar.set(ACTIVE_WORKSPACE_COOKIE, actor.workspaceId, opts);
  jar.set(ACTIVE_ORG_COOKIE, id, opts);
  redirect("/dashboard");
}

/** A workspace admin opens a company they don't have access to yet. */
export async function joinCompany(organizationId: string): Promise<ActionResult> {
  const actor = await requireWorkspaceActor("admin");
  const r = await workspaceAction("admin", async (ctx) => {
    await ws.setCompanyAccess(ctx, { userId: actor.userId, organizationId, role: "admin" });
    return { id: organizationId };
  });
  if (r.ok) revalidatePath("/workspace");
  return r;
}

export async function renameWorkspace(name: string): Promise<ActionResult> {
  const r = await workspaceAction("admin", (ctx) => ws.renameWorkspace(ctx, { name }));
  if (r.ok) revalidatePath("/workspace");
  return r;
}
