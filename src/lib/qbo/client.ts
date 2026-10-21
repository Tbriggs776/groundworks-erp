import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboConnections, type QboConnection } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { seal, unseal } from "@/lib/security/crypto";
import { QBO_MINOR_VERSION, qboConfig } from "./config";
import { refreshTokens, type Tokens } from "./oauth";

/**
 * Reading a company's QuickBooks data. Refreshes the access token when it's
 * about to expire (or QuickBooks says it has), and saves new tokens on
 * their own connection right away: a batch that fails and rolls back must
 * not lose the only refresh token that still works. Waits and retries when
 * QuickBooks throttles (429) or hiccups (5xx).
 */

export const PAGE_SIZE = 1000;
const RETRIES = 4;

export type QboRecord = Record<string, unknown> & { Id: string };

export class QboClient {
  private conn: QboConnection;

  constructor(conn: QboConnection) {
    this.conn = conn;
  }

  get realmId() {
    return this.conn.realmId;
  }

  /** Save fresh tokens to a connection (outside any batch transaction). */
  static async saveTokens(connectionId: string, t: Tokens) {
    await db
      .update(qboConnections)
      .set({
        accessToken: seal(t.accessToken),
        refreshToken: seal(t.refreshToken),
        accessExpiresAt: t.accessExpiresAt,
        refreshExpiresAt: t.refreshExpiresAt,
        updatedAt: sql`now()`,
      })
      .where(eq(qboConnections.id, connectionId));
  }

  private async token(force = false): Promise<string> {
    if (!this.conn.accessToken || !this.conn.refreshToken) {
      throw new AppError("invalid_state", "This company is no longer connected to QuickBooks. Connect it again to continue.");
    }
    const soon = Date.now() + 5 * 60 * 1000;
    if (force || !this.conn.accessExpiresAt || this.conn.accessExpiresAt.getTime() < soon) {
      const t = await refreshTokens(unseal(this.conn.refreshToken));
      await QboClient.saveTokens(this.conn.id, t);
      this.conn = { ...this.conn, accessToken: seal(t.accessToken), refreshToken: seal(t.refreshToken), accessExpiresAt: t.accessExpiresAt };
      return t.accessToken;
    }
    return unseal(this.conn.accessToken);
  }

  /** GET a company resource (path after /v3/company/<realm>/). */
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${qboConfig().apiBase}/v3/company/${this.conn.realmId}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("minorversion", QBO_MINOR_VERSION);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${await this.token(false)}`, accept: "application/json" } });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.token(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        continue;
      }
      const json = (await res.json().catch(() => null)) as (T & { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } }) | null;
      if (!res.ok || !json || json.Fault) {
        const e = json?.Fault?.Error?.[0];
        throw new AppError("upstream_error", `QuickBooks: ${e?.Detail ?? e?.Message ?? `request failed (${res.status})`}`, { status: res.status, path });
      }
      return json;
    }
  }

  /**
   * One page of a query: `select * from <entity> [where …]` in QuickBooks'
   * own order. Importers check the count at the end and rescan if anything
   * slipped between pages (the id map makes a rescan safe).
   */
  async page(entity: string, startPosition: number, where = ""): Promise<QboRecord[]> {
    const q = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${startPosition} maxresults ${PAGE_SIZE}`;
    const r = await this.get<{ QueryResponse: Record<string, QboRecord[] | number | undefined> }>("query", { query: q });
    const rows = r.QueryResponse[entity];
    return Array.isArray(rows) ? rows : [];
  }

  /** How many records a query matches. */
  async count(entity: string, where = ""): Promise<number> {
    const q = `select count(*) from ${entity}${where ? ` where ${where}` : ""}`;
    const r = await this.get<{ QueryResponse: { totalCount?: number } }>("query", { query: q });
    return r.QueryResponse.totalCount ?? 0;
  }

  /** A QuickBooks report (TrialBalance, …). */
  report<T>(name: string, params: Record<string, string>): Promise<T> {
    return this.get<T>(`reports/${name}`, params);
  }
}
