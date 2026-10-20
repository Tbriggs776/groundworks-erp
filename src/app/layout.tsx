import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Cinzel, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

/**
 * Body, tables, forms: modern, with tabular figures for money. (Geist over
 * Inter: Inter's hyphen sits in wide space, so "sign-in" reads "sign - in".)
 */
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

/** Headings and the wordmark: letterspaced classical Roman capitals. */
const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

/** Codes, keys, and figures in tables: same family as the body text. */
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Groundworks",
  description:
    "Small-business accounting with a first-class API and MCP server, built for teams of humans and AI agents.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FFFFFF",
  colorScheme: "light",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Reading the request makes every page dynamic, which the per-request
  // CSP nonce (set by src/proxy.ts) requires: Next stamps it on its scripts.
  await headers();
  return (
    <html
      lang="en"
      className={`${geist.variable} ${cinzel.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
