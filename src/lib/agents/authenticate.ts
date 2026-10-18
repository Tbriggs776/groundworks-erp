import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, apiKeys, memberships, organizations } from "@/lib/db/schema";
import {
  intersectScopes,
  scopesForAutonomy,
  scopesForRole,
  type Actor,
  type Channel,
} from "@/lib/actor";
import { AppError } from "@/lib/errors";
import { hashApiKey, looksLikeApiKey } from "./keys";

/**
 * Turn a bearer token into an Actor. Every check runs on every request, so
 * revoking a key, deactivating an agent, removing a member, or lowering an
 * agent's autonomy takes effect immediately.
 *
 * Failures are deliberately vague ("invalid or revoked API key") so a
 * caller can't distinguish "never existed" from "revoked".
 */
export async function authenticateApiKey(
  token: string | null | undefined,
  channel: Exclude<Channel, "ui" | "system">
): Promise<Actor> {
  if (!token) {
    throw new AppError(
      "unauthenticated",
      "Missing API key. Send `Authorization: Bearer gwk_…`."
    );
  }
  if (!looksLikeApiKey(token)) {
    throw new AppError("unauthenticated", "Invalid or revoked API key.");
  }

  const [row] = await db
    .select({
      key: apiKeys,
      agent: agents,
      memberRole: memberships.role,
      memberActive: memberships.isActive,
    })
    .from(apiKeys)
    .innerJoin(
      organizations,
      and(eq(organizations.id, apiKeys.organizationId), isNull(organizations.deletedAt))
    )
    .leftJoin(agents, eq(agents.id, apiKeys.agentId))
    .leftJoin(
      memberships,
      and(
        eq(memberships.userId, apiKeys.userId),
        eq(memberships.organizationId, apiKeys.organizationId),
        isNull(memberships.deletedAt)
      )
    )
    .where(eq(apiKeys.secretHash, hashApiKey(token)));

  const invalid = new AppError("unauthenticated", "Invalid or revoked API key.");
  if (!row || row.key.revokedAt || row.key.deletedAt) throw invalid;
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= Date.now()) {
    throw new AppError("unauthenticated", "API key has expired.");
  }

  let actor: Actor;
  if (row.agent) {
    if (!row.agent.isActive || row.agent.deletedAt) throw invalid;
    actor = {
      organizationId: row.key.organizationId,
      kind: "agent",
      role: row.agent.role,
      userId: null,
      agentId: row.agent.id,
      agentName: row.agent.name,
      apiKeyId: row.key.id,
      scopes: intersectScopes(
        row.key.scopes,
        scopesForAutonomy(row.agent.autonomy),
        scopesForRole(row.agent.role)
      ),
      channel,
      maxPostAmount: row.agent.autonomy === "post" ? row.agent.maxPostAmount : null,
      requestId: randomUUID(),
    };
  } else {
    if (!row.memberRole || !row.memberActive || !row.key.userId) throw invalid;
    actor = {
      organizationId: row.key.organizationId,
      kind: "user",
      role: row.memberRole,
      userId: row.key.userId,
      agentId: null,
      agentName: null,
      apiKeyId: row.key.id,
      scopes: intersectScopes(row.key.scopes, scopesForRole(row.memberRole)),
      channel,
      maxPostAmount: null,
      requestId: randomUUID(),
    };
  }

  // Usage stamps, throttled to one write per key per minute.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, row.key.id),
        sql`(${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < now() - interval '1 minute')`
      )
    );
  if (row.agent) {
    await db
      .update(agents)
      .set({ lastActiveAt: sql`now()` })
      .where(
        and(
          eq(agents.id, row.agent.id),
          sql`(${agents.lastActiveAt} IS NULL OR ${agents.lastActiveAt} < now() - interval '1 minute')`
        )
      );
  }
  return actor;
}

/** Pull the token from `Authorization: Bearer …` or `x-api-key`. */
export function tokenFromHeaders(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) return m[1];
  }
  return headers.get("x-api-key");
}
