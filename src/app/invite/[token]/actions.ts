"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ORG_COOKIE, ACTIVE_WORKSPACE_COOKIE, getRequestMeta, requireUser } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { toAppError } from "@/lib/errors";
import { acceptInvitation } from "@/lib/workspace/service";

const COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

export async function acceptInvite(token: string): Promise<{ error: string } | void> {
  const user = await requireUser();
  const meta = await getRequestMeta();
  let joined: { workspaceId: string; organizationId: string | null };
  try {
    joined = await db.transaction((tx) => acceptInvitation(tx, user, token, meta));
  } catch (err) {
    return { error: toAppError(err).message };
  }
  const jar = await cookies();
  jar.set(ACTIVE_WORKSPACE_COOKIE, joined.workspaceId, COOKIE);
  if (joined.organizationId) jar.set(ACTIVE_ORG_COOKIE, joined.organizationId, COOKIE);
  redirect(joined.organizationId ? "/dashboard" : "/workspace");
}
