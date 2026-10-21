import { AppError } from "@/lib/errors";

/**
 * QuickBooks Online settings, from the environment:
 *
 *   QBO_CLIENT_ID, QBO_CLIENT_SECRET   the Intuit app's keys
 *   QBO_ENVIRONMENT                    sandbox (default) or production
 *   NEXT_PUBLIC_APP_URL                the redirect is <it>/api/qbo/callback;
 *                                      register exactly that in the Intuit app
 *
 * Tests point QBO_AUTH_URL, QBO_TOKEN_URL, QBO_REVOKE_URL, and QBO_API_BASE
 * at a fake QuickBooks server.
 */

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_MINOR_VERSION = "75";

export type QboConfig = {
  clientId: string;
  clientSecret: string;
  environment: "sandbox" | "production";
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
};

export function qboConfigured(): boolean {
  return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);
}

export function qboConfig(): QboConfig {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError("invalid_state", "QuickBooks isn't set up yet: QBO_CLIENT_ID and QBO_CLIENT_SECRET are missing.");
  }
  const environment = process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox";
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    clientId,
    clientSecret,
    environment,
    redirectUri: `${appUrl}/api/qbo/callback`,
    authUrl: process.env.QBO_AUTH_URL ?? "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: process.env.QBO_TOKEN_URL ?? "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revokeUrl: process.env.QBO_REVOKE_URL ?? "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    apiBase:
      process.env.QBO_API_BASE ??
      (environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com"),
  };
}
