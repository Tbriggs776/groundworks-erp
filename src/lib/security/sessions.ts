import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { userSessions, workspaceMembers, workspaces, type UserSession } from "@/lib/db/schema";
import type { RequestMeta, Tx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { hasVerifiedFactor } from "./mfa";

/**
 * SESSION CONTROL — what makes a Supabase sign-in acceptable to us on each
 * request. Supabase proves who someone is; this decides whether that
 * proof is still good enough under the policy of every workspace they
 * belong to (the strictest wins):
 *
 *   revoked        signed out here or from another device
 *   idle_timeout   no activity for longer than the idle limit
 *   max_age        signed in longer ago than the session limit
 *   mfa_required   has (or must have) a second factor but this session
 *                  hasn't used it
 *
 * The first request of a new Supabase session records it (and writes an
 * `auth.signed_in` audit row to each of the person's workspaces).
 */

export type SessionPolicy = { requireMfa: boolean; idleMinutes: number; maxHours: number };

/** Used before someone belongs to any workspace (mid sign-up). */
export const DEFAULT_SESSION_POLICY: SessionPolicy = { requireMfa: false, idleMinutes: 60, maxHours: 24 };

export type SessionClaims = {
  userId: string;
  sessionId: string;
  aal: string;
  /** When the person authenticated (first factor). */
  authenticatedAt: Date;
  /** Sign-in methods from the JWT `amr` claim, e.g. ["otp"], ["otp","totp"]. */
  methods: string[];
};

export type SessionVerdict =
  | { ok: true; policy: SessionPolicy }
  | { ok: false; reason: "revoked" | "idle_timeout" | "max_age" | "mfa_required"; policy: SessionPolicy };

/** Strictest policy across the person's active workspaces. */
export async function effectivePolicy(tx: Tx, userId: string): Promise<SessionPolicy> {
  const [row] = await tx
    .select({
      n: sql<number>`count(*)::int`,
      requireMfa: sql<boolean>`coalesce(bool_or(${workspaces.requireMfa}), false)`,
      idleMinutes: sql<number | null>`min(${workspaces.sessionIdleMinutes})`,
      maxHours: sql<number | null>`min(${workspaces.sessionMaxHours})`,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, and(eq(workspaces.id, workspaceMembers.workspaceId), isNull(workspaces.deletedAt)))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.isActive, true),
        isNull(workspaceMembers.deletedAt)
      )
    );
  if (!row || row.n === 0) return DEFAULT_SESSION_POLICY;
  return {
    requireMfa: row.requireMfa,
    idleMinutes: row.idleMinutes ?? DEFAULT_SESSION_POLICY.idleMinutes,
    maxHours: row.maxHours ?? DEFAULT_SESSION_POLICY.maxHours,
  };
}

async function workspaceIdsOf(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.isActive, true), isNull(workspaceMembers.deletedAt)));
  return rows.map((r) => r.id);
}

/** One audit row per workspace the person belongs to. */
async function auditForUser(
  tx: Tx,
  userId: string,
  event: string,
  meta: RequestMeta,
  metadata: Record<string, unknown>,
  actorId: string | null = userId
) {
  for (const workspaceId of await workspaceIdsOf(tx, userId)) {
    await writeAudit(
      {
        workspaceId,
        actorId,
        actorType: actorId ? "user" : "system",
        channel: actorId ? "ui" : "system",
        event,
        entityType: "user",
        entityId: userId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata,
      },
      tx
    );
  }
}

async function revoke(tx: Tx, s: UserSession, reason: string, meta: RequestMeta) {
  await tx
    .update(userSessions)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(userSessions.id, s.id), isNull(userSessions.revokedAt)));
  await auditForUser(tx, s.userId, "auth.session.ended", meta, { sessionId: s.id, reason }, null);
}

/** Check (and record) the current session. Runs on every authenticated request. */
export async function checkSession(claims: SessionClaims, meta: RequestMeta): Promise<SessionVerdict> {
  return db.transaction(async (tx) => {
    const policy = await effectivePolicy(tx, claims.userId);
    const [existing] = await tx.select().from(userSessions).where(eq(userSessions.id, claims.sessionId));

    if (!existing) {
      const [created] = await tx
        .insert(userSessions)
        .values({
          id: claims.sessionId,
          userId: claims.userId,
          authenticatedAt: claims.authenticatedAt,
          aal: claims.aal,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        await auditForUser(tx, claims.userId, "auth.signed_in", meta, {
          sessionId: claims.sessionId,
          methods: claims.methods,
          aal: claims.aal,
        });
        // A sign-in from before this record existed can already be too old.
        if (Date.now() - created.authenticatedAt.getTime() > policy.maxHours * 3_600_000) {
          await revoke(tx, created, "max_age", meta);
          return { ok: false, reason: "max_age", policy };
        }
      }
    } else {
      if (existing.revokedAt || existing.userId !== claims.userId) {
        return { ok: false, reason: "revoked", policy };
      }
      const now = Date.now();
      if (now - existing.lastSeenAt.getTime() > policy.idleMinutes * 60_000) {
        await revoke(tx, existing, "idle_timeout", meta);
        return { ok: false, reason: "idle_timeout", policy };
      }
      if (now - existing.authenticatedAt.getTime() > policy.maxHours * 3_600_000) {
        await revoke(tx, existing, "max_age", meta);
        return { ok: false, reason: "max_age", policy };
      }
      if (existing.aal !== claims.aal && claims.aal === "aal2") {
        await auditForUser(tx, claims.userId, "auth.mfa.verified", meta, { sessionId: claims.sessionId });
      }
      // Activity stamp, at most once a minute per session.
      await tx
        .update(userSessions)
        .set({ lastSeenAt: sql`now()`, aal: claims.aal })
        .where(
          and(
            eq(userSessions.id, existing.id),
            sql`(${userSessions.lastSeenAt} < now() - interval '1 minute' OR ${userSessions.aal} <> ${claims.aal})`
          )
        );
    }

    if (claims.aal !== "aal2") {
      const enrolled = await hasVerifiedFactor(tx, claims.userId);
      if (enrolled || policy.requireMfa) return { ok: false, reason: "mfa_required", policy };
    }
    return { ok: true, policy };
  });
}

/** Mark the session ended (sign-out, or a forced end the caller already decided). */
export async function endSession(sessionId: string, reason: string, meta: RequestMeta): Promise<void> {
  await db.transaction(async (tx) => {
    const [s] = await tx.select().from(userSessions).where(eq(userSessions.id, sessionId));
    if (!s || s.revokedAt) return;
    await tx
      .update(userSessions)
      .set({ revokedAt: sql`now()`, revokedReason: reason })
      .where(eq(userSessions.id, s.id));
    await auditForUser(tx, s.userId, reason === "signed_out" ? "auth.signed_out" : "auth.session.ended", meta, {
      sessionId,
      reason,
    });
  });
}

/** Active sessions for one person, newest activity first. */
export async function listSessions(userId: string): Promise<UserSession[]> {
  return db
    .select()
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .orderBy(desc(userSessions.lastSeenAt))
    .limit(50);
}

/** "Sign out everywhere else." Returns how many sessions ended. */
export async function revokeOtherSessions(userId: string, keepSessionId: string, meta: RequestMeta): Promise<number> {
  return db.transaction(async (tx) => {
    const ended = await tx
      .update(userSessions)
      .set({ revokedAt: sql`now()`, revokedReason: "revoked_by_user" })
      .where(and(eq(userSessions.userId, userId), ne(userSessions.id, keepSessionId), isNull(userSessions.revokedAt)))
      .returning({ id: userSessions.id });
    if (ended.length > 0) {
      await auditForUser(tx, userId, "auth.sessions.revoked", meta, { count: ended.length, kept: keepSessionId });
    }
    return ended.length;
  });
}

/**
 * Housekeeping (cron): forget sessions that ended, or went quiet, more
 * than 90 days ago. Sign-in history stays in the audit log.
 */
export async function pruneSessions(): Promise<number> {
  const rows = await db
    .delete(userSessions)
    .where(
      sql`(${userSessions.revokedAt} < now() - interval '90 days')
       OR (${userSessions.revokedAt} IS NULL AND ${userSessions.lastSeenAt} < now() - interval '90 days')`
    )
    .returning({ id: userSessions.id });
  return rows.length;
}
