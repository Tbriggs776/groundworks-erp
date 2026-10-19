"use server";

import { revalidatePath } from "next/cache";
import { getRequestMeta, requireUser } from "@/lib/auth";
import { revokeOtherSessions } from "@/lib/security/sessions";
import { createClient } from "@/lib/supabase/server";

/** Sign out every other session: here (immediate) and at Supabase (refresh tokens). */
export async function signOutOtherSessions(): Promise<{ ended: number }> {
  const user = await requireUser();
  if (!user.sessionId) return { ended: 0 };
  const ended = await revokeOtherSessions(user.id, user.sessionId, await getRequestMeta());
  await (await createClient()).auth.signOut({ scope: "others" }).catch(() => undefined);
  revalidatePath("/account/security");
  return { ended };
}

/** Keeps the session's activity stamp fresh while the person is working in the page. */
export async function keepAlive(): Promise<void> {
  await requireUser();
}
