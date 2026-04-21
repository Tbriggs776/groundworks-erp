import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  /*
   * Pin Turbopack's workspace root to this project. Without this, Next detects
   * a stray package-lock.json in C:\Users\Tyler\ and warns on every boot.
   */
  turbopack: {
    root: path.resolve(import.meta.dirname ?? __dirname),
  },
};

export default nextConfig;
