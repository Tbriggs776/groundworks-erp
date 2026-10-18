"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ORG_COOKIE, requireUser } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { toAppError } from "@/lib/errors";
import { acceptInvitation } from "@/lib/team/service";

export async function acceptInvite(token: string): Promise<{ error: string } | void> {
  const user = await requireUser();
  let organizationId: string;
  try {
    ({ organizationId } = await db.transaction((tx) => acceptInvitation(tx, user, token)));
  } catch (err) {
    return { error: toAppError(err).message };
  }
  (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect("/dashboard");
}
