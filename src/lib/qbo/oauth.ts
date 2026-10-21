import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/errors";
import { sign, verifySigned } from "@/lib/security/crypto";
import { QBO_SCOPE, qboConfig } from "./config";

/**
 * Sign in with Intuit (OAuth 2.0 authorization code). The state names the
 * workspace and person who started it, signed, and must match a nonce in
 * a short-lived cookie on the same browser, so a callback can't be forged
 * or replayed from elsewhere.
 */

export const STATE_COOKIE = "gw_qbo_state";
const STATE_TTL_MS = 10 * 60 * 1000;

/** w: workspace, u: person, n: nonce, t: time; o: the company, when reconnecting one. */
export type QboState = { w: string; u: string; n: string; t: number; o?: string };

export function startAuthorization(who: { workspaceId: string; userId: string; organizationId?: string }): { url: string; nonce: string } {
  const cfg = qboConfig();
  const nonce = randomBytes(16).toString("base64url");
  const state = sign({ w: who.workspaceId, u: who.userId, n: nonce, t: Date.now(), ...(who.organizationId ? { o: who.organizationId } : {}) } satisfies QboState);
  const url = new URL(cfg.authUrl);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QBO_SCOPE);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return { url: url.toString(), nonce };
}

/** The state if it's ours, fresh, for this person, and matches the cookie's nonce. */
export function checkState(state: string | null, cookieNonce: string | undefined, userId: string): QboState {
  const s = state ? verifySigned<QboState>(state) : null;
  if (!s || !cookieNonce || s.n !== cookieNonce || s.u !== userId || Date.now() - s.t > STATE_TTL_MS) {
    throw new AppError("forbidden", "That QuickBooks sign-in didn't start here or has expired. Start the import again.");
  }
  return s;
}

export type Tokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
};

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const cfg = qboConfig();
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token || !json.refresh_token) {
    throw new AppError(
      json.error === "invalid_grant" ? "forbidden" : "upstream_error",
      json.error === "invalid_grant"
        ? "QuickBooks refused the sign-in (it may have expired or been revoked). Connect again."
        : `QuickBooks sign-in failed (${res.status}${json.error ? `: ${json.error}` : ""}).`
    );
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    accessExpiresAt: new Date(now + (json.expires_in ?? 3600) * 1000),
    refreshExpiresAt: new Date(now + (json.x_refresh_token_expires_in ?? 100 * 86400) * 1000),
  };
}

export function exchangeCode(code: string): Promise<Tokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: qboConfig().redirectUri });
}

export function refreshTokens(refreshToken: string): Promise<Tokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Tell Intuit to forget the tokens. Best effort: a failure here never blocks a disconnect. */
export async function revokeToken(token: string): Promise<void> {
  const cfg = qboConfig();
  await fetch(cfg.revokeUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
}
