/**
 * HTTP security headers. The CSP is per request (it carries a nonce) and is
 * set by the proxy on pages; the static headers below go on every response,
 * API included, via next.config.ts.
 */

function supabaseOrigins(): string[] {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return [];
  try {
    const u = new URL(url);
    return [u.origin, `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`];
  } catch {
    return [];
  }
}

const origin = (url: string | undefined, fallback: string) => {
  try {
    return url ? new URL(url).origin : fallback;
  } catch {
    return fallback;
  }
};

/** Plaid's sign-in window (a frame from its CDN, which calls Plaid's API) runs on the Bank Feeds page only. */
export const PLAID_LINK_PATH = "/banking/feeds";
function plaidOrigins() {
  const api = process.env.PLAID_ENV === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
  return {
    frame: origin(process.env.PLAID_LINK_SCRIPT_URL, "https://cdn.plaid.com"),
    api: origin(process.env.PLAID_API_BASE, api),
  };
}

export function contentSecurityPolicy(nonce: string, pathname = "/"): string {
  const dev = process.env.NODE_ENV === "development";
  const plaid = pathname === PLAID_LINK_PATH || pathname.startsWith(`${PLAID_LINK_PATH}/`) ? plaidOrigins() : null;
  const directives = [
    "default-src 'self'",
    // Next tags its own scripts with the nonce; strict-dynamic lets them load chunks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self' ${[...supabaseOrigins(), ...(plaid ? [plaid.frame, plaid.api] : [])].join(" ")}`.trim(),
    ...(plaid ? [`frame-src 'self' ${plaid.frame}`] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_APP_URL?.startsWith("https:")
      ? ["upgrade-insecure-requests"]
      : []),
  ];
  return directives.join("; ");
}

export const STATIC_SECURITY_HEADERS: Array<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
