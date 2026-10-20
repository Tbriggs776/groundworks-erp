"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ACTIVE_ORG_COOKIE,
  ACTIVE_WORKSPACE_COOKIE,
  getRequestMeta,
  getUserMemberships,
  getUserWorkspaces,
  requireUser,
  type SupportVia,
} from "@/lib/auth";
import { recordSupportOpened } from "@/lib/security/support";

const COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

/**
 * Switch the active company (and with it the workspace). Access is
 * verified here and again on every request by getCurrentOrg.
 */
export async function switchOrganization(organizationId: string): Promise<void> {
  const user = await requireUser();
  const target = (await getUserMemberships()).find((m) => m.organizationId === organizationId);
  if (!target) throw new Error("You don't have access to that company.");
  await logSupportOpen(user.id, target.organization.workspaceId, target.support);
  const jar = await cookies();
  jar.set(ACTIVE_ORG_COOKIE, organizationId, COOKIE);
  jar.set(ACTIVE_WORKSPACE_COOKIE, target.organization.workspaceId, COOKIE);
  redirect("/dashboard");
}

/** Switch to a workspace; lands on its first company, or its home if none. */
export async function switchWorkspace(workspaceId: string): Promise<void> {
  const user = await requireUser();
  const target = (await getUserWorkspaces()).find((w) => w.workspaceId === workspaceId);
  if (!target) throw new Error("You're not a member of that workspace.");
  await logSupportOpen(user.id, workspaceId, target.support);
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, COOKIE);
  const first = (await getUserMemberships()).find((m) => m.organization.workspaceId === workspaceId);
  redirect(first ? "/dashboard" : "/workspace");
}

/** Support opening a customer's workspace goes in that workspace's audit log. */
async function logSupportOpen(userId: string, workspaceId: string, via: SupportVia | undefined) {
  if (via) await recordSupportOpened(userId, workspaceId, via.grantId, await getRequestMeta());
}
