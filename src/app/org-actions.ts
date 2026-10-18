"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ORG_COOKIE, getUserMemberships, requireUser } from "@/lib/auth";

/**
 * Switch the active organization (for people in more than one — e.g. an
 * accountant serving several clients). Membership is verified here and
 * again on every request by getCurrentOrg.
 */
export async function switchOrganization(organizationId: string): Promise<void> {
  await requireUser();
  const all = await getUserMemberships();
  if (!all.some((m) => m.organizationId === organizationId)) {
    throw new Error("You are not a member of that organization.");
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
