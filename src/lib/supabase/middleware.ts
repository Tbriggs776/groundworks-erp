import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@/lib/security/headers";

/**
 * Runs from `src/proxy.ts` on every page request:
 *   1. builds a per-request CSP nonce (Next applies it to its own scripts)
 *   2. refreshes the Supabase session cookies
 *   3. sends signed-out visitors to /auth/login, and signed-in ones away
 *      from the sign-in / sign-up pages
 *
 * Session *policy* (timeouts, revocation, MFA) is enforced server-side in
 * requireUser (src/lib/auth.ts), which can read the database.
 */

/** Reachable without a session. */
const PUBLIC_PATHS = ["/", "/signup"];
const PUBLIC_PREFIXES = ["/auth/"];
/** Signed-in users skip these. */
const SIGNED_OUT_ONLY = ["/auth/login", "/auth/forgot", "/signup"];

export async function updateSession(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const next = () => {
    const r = NextResponse.next({ request: { headers: requestHeaders } });
    r.headers.set("content-security-policy", csp);
    return r;
  };
  let response = next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = next();
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // getClaims verifies the JWT (locally with asymmetric keys) and refreshes
  // an expired session through the cookie hooks above.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    url.search = "";
    url.searchParams.set("redirectTo", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (signedIn && SIGNED_OUT_ONLY.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
