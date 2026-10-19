"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ORG_COOKIE, ACTIVE_WORKSPACE_COOKIE, getRequestMeta, requireUser } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { companyFields, formError, type FormState } from "@/lib/ui/form-state";
import { createWorkspace } from "@/lib/workspace/service";

const COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

/**
 * Sign-up step 1: create the workspace and its first company (the user
 * owns both), make them active, then go invite the team.
 */
export async function startWorkspace(_prev: FormState, data: FormData): Promise<FormState> {
  const user = await requireUser();
  const meta = await getRequestMeta();
  let ids: { workspaceId: string; organizationId: string };
  try {
    ids = await db.transaction((tx) => createWorkspace(tx, user, companyFields(data), meta));
  } catch (err) {
    console.error("[onboarding] createWorkspace failed:", err);
    return formError(err);
  }
  const jar = await cookies();
  jar.set(ACTIVE_WORKSPACE_COOKIE, ids.workspaceId, COOKIE);
  jar.set(ACTIVE_ORG_COOKIE, ids.organizationId, COOKIE);
  redirect("/onboarding/team");
}
