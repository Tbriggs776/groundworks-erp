import type { NextConfig } from "next";
import path from "node:path";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  /*
   * Pin Turbopack's workspace root to this project. Without this, Next detects
   * a stray package-lock.json in C:\Users\Tyler\ and warns on every boot.
   */
  turbopack: {
    root: path.resolve(import.meta.dirname ?? __dirname),
  },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }];
  },
};

export default nextConfig;
