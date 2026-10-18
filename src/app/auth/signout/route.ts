import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requestMeta } from "@/lib/actor";
import { getSessionVerdict } from "@/lib/auth";
import { endSession } from "@/lib/security/sessions";
import { createClient } from "@/lib/supabase/server";

/**
 * Sign out.
 *   POST  the person clicked "Sign out"
 *   GET   a forced sign-out after requireUser rejected the session (idle,
 *         too old, revoked). GET only acts on a session that already failed
 *         policy, so a stray link can't sign anyone out.
 */
const FORCED = new Set(["idle_timeout", "max_age", "revoked"]);

export async function POST(request: Request) {
  return signOut(request, "signed_out");
}

export async function GET(request: Request) {
  const reason = new URL(request.url).searchParams.get("reason") ?? "";
  const verdict = await getSessionVerdict();
  if (verdict?.ok) return NextResponse.redirect(new URL("/dashboard", request.url), 303);
  return signOut(request, FORCED.has(reason) ? reason : "revoked");
}

async function signOut(request: Request, reason: string) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sessionId = data?.claims?.session_id;
  if (typeof sessionId === "string") {
    await endSession(sessionId, reason, requestMeta(request.headers));
  }
  // Revokes this session's refresh token at Supabase and clears cookies.
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);

  const login = new URL("/auth/login", request.url);
  if (reason !== "signed_out") login.searchParams.set("reason", reason);
  const res = NextResponse.redirect(login, 303);
  // Belt and braces if Supabase couldn't be reached: drop the auth cookies.
  for (const c of (await cookies()).getAll()) {
    if (c.name.startsWith("sb-")) res.cookies.delete(c.name);
  }
  return res;
}
