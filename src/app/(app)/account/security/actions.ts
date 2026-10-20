"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action";
import { getRequestMeta, requireUser } from "@/lib/auth";
import { authErrorMessage, newPasswordSchema } from "@/lib/security/password";
import { auditPasswordChanged, revokeOtherSessions } from "@/lib/security/sessions";
import { createClient } from "@/lib/supabase/server";

/**
 * Set or change the signed-in person's password, then end every other
 * session, so a reset also locks out whoever held the account before.
 * Used by My security and by the reset link (/auth/reset).
 */
export async function setPassword(password: string): Promise<ActionResult<{ ended: number }>> {
  const user = await requireUser();
  const parsed = newPasswordSchema.safeParse(password);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, code: "invalid_input" };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) return { ok: false, error: authErrorMessage(error), code: "invalid_input" };

  const meta = await getRequestMeta();
  const ended = user.sessionId ? await revokeOtherSessions(user.id, user.sessionId, meta) : 0;
  await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
  await auditPasswordChanged(user.id, meta, ended);
  revalidatePath("/account/security");
  return { ok: true, ended };
}

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
