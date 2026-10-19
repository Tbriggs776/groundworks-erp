"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ACTIVE_ORG_COOKIE,
  ACTIVE_WORKSPACE_COOKIE,
  getUserMemberships,
  getUserWorkspaces,
  requireUser,
} from "@/lib/auth";

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
  await requireUser();
  const target = (await getUserMemberships()).find((m) => m.organizationId === organizationId);
  if (!target) throw new Error("You don't have access to that company.");
  const jar = await cookies();
  jar.set(ACTIVE_ORG_COOKIE, organizationId, COOKIE);
  jar.set(ACTIVE_WORKSPACE_COOKIE, target.organization.workspaceId, COOKIE);
  redirect("/dashboard");
}

/** Switch to a workspace; lands on its first company, or its home if none. */
export async function switchWorkspace(workspaceId: string): Promise<void> {
  await requireUser();
  if (!(await getUserWorkspaces()).some((w) => w.workspaceId === workspaceId)) {
    throw new Error("You're not a member of that workspace.");
  }
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, COOKIE);
  const first = (await getUserMemberships()).find((m) => m.organization.workspaceId === workspaceId);
  redirect(first ? "/dashboard" : "/workspace");
}
