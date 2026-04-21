import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next.js 16 "proxy" (formerly middleware). Refreshes the Supabase session
 * cookie on every request and redirects unauthenticated users to /auth/login.
 * See src/lib/supabase/middleware.ts for the session-refresh helper.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on everything except:
     *   - _next/static, _next/image (bundles, images)
     *   - favicon / public assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
