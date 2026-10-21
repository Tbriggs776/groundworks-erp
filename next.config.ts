import type { NextConfig } from "next";
import path from "node:path";
import { PLAID_LINK_PATH, STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  /*
   * Pin Turbopack's workspace root to this project. Without this, Next detects
   * a stray package-lock.json in C:\Users\Tyler\ and warns on every boot.
   */
  turbopack: {
    root: path.resolve(import.meta.dirname ?? __dirname),
  },
  poweredByHeader: false,
  experimental: {
    // Bank statement imports travel through a server action. Vercel caps
    // request bodies at 4.5 MB; the import form refuses files over 4 MB.
    serverActions: { bodySizeLimit: "5mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: STATIC_SECURITY_HEADERS },
      // Some banks sign in through a popup that Plaid's window has to keep a handle on.
      { source: PLAID_LINK_PATH, headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }] },
    ];
  },
};

export default nextConfig;
