import { AppError } from "@/lib/errors";

/**
 * Plaid, the bank connection service, from the environment:
 *
 *   PLAID_CLIENT_ID, PLAID_SECRET   the Plaid team's keys
 *   PLAID_ENV                       sandbox (default) or production
 *   PLAID_REDIRECT_URI              optional: <app>/banking/feeds, registered
 *                                   in Plaid, for banks that sign in with OAuth
 *   NEXT_PUBLIC_APP_URL             webhooks go to <it>/api/webhooks/plaid
 *
 * Tests point PLAID_API_BASE and PLAID_LINK_SCRIPT_URL at a fake Plaid.
 */

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export function plaidConfig() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) throw new AppError("invalid_state", "Bank feeds aren't set up yet: PLAID_CLIENT_ID and PLAID_SECRET are missing.");
  const production = process.env.PLAID_ENV === "production";
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    clientId,
    secret,
    environment: production ? ("production" as const) : ("sandbox" as const),
    apiBase: process.env.PLAID_API_BASE ?? (production ? "https://production.plaid.com" : "https://sandbox.plaid.com"),
    webhookUrl: `${appUrl}/api/webhooks/plaid`,
    redirectUri: process.env.PLAID_REDIRECT_URI || undefined,
  };
}

/** Plaid Link's script (the bank sign-in window), and the origin its frame comes from. */
export const linkScriptUrl = () => process.env.PLAID_LINK_SCRIPT_URL ?? "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
export function linkOrigin(): string {
  try {
    return new URL(linkScriptUrl()).origin;
  } catch {
    return "https://cdn.plaid.com";
  }
}

export type PlaidError = { error_type?: string; error_code?: string; error_message?: string; display_message?: string | null };

/** Codes a person has to act on: the bank wants them to sign in again. */
export const LOGIN_REQUIRED = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "INVALID_CREDENTIALS", "INSUFFICIENT_CREDENTIALS"]);

/** POST to Plaid with the team's keys. Plaid's errors become AppErrors carrying its code. */
export async function plaid<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const cfg = plaidConfig();
  let res: Response;
  try {
    res = await fetch(`${cfg.apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
    });
  } catch {
    throw new AppError("upstream_error", "Couldn't reach the bank connection service. Try again in a minute.");
  }
  const json = (await res.json().catch(() => null)) as (T & PlaidError) | null;
  if (!res.ok || !json || json.error_code) {
    const code = json?.error_code ?? `HTTP_${res.status}`;
    if (LOGIN_REQUIRED.has(code)) {
      throw new AppError("invalid_state", "The bank needs you to sign in again. Reconnect it on the Bank Feeds page.", { plaidError: code });
    }
    throw new AppError("upstream_error", `The bank connection service said: ${json?.display_message ?? json?.error_message ?? code}`, { plaidError: code });
  }
  return json;
}

export type PlaidAccount = {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
};

export type PlaidTransaction = {
  transaction_id: string;
  account_id: string;
  /** Plaid's sign: positive is money out of the account (a purchase, a charge). */
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  name?: string | null;
  merchant_name?: string | null;
  original_description?: string | null;
  check_number?: string | null;
  pending: boolean;
};

export type SyncPage = {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string; account_id?: string }>;
  next_cursor: string;
  has_more: boolean;
};
