import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth / magic-link callback. Supabase sends the user back here with a
 * `code` param; we exchange it for a session and redirect.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const redirectTo = url.searchParams.get("redirectTo") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const err = new URL("/auth/login", url.origin);
      err.searchParams.set("error", error.message);
      return NextResponse.redirect(err);
    }
  }

  return NextResponse.redirect(new URL(redirectTo, url.origin));
}
