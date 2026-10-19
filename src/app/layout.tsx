import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Bebas_Neue, Epilogue, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const epilogue = Epilogue({
  variable: "--font-epilogue",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const bebas = Bebas_Neue({
  variable: "--font-bebas",
  subsets: ["latin"],
  weight: "400",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
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
  themeColor: "#141210",
  colorScheme: "dark",
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
      className={`dark ${epilogue.variable} ${bebas.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
