import { and, desc, eq, gt, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspaceRole, workspaceAuditFields, type RequestMeta, type WsCtx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db/client";
import { auditLog, profiles, supportAccessGrants, workspaces, type Workspace } from "@/lib/db/schema";

/**
 * GROUNDWORKS SUPPORT ACCESS — off unless a workspace owner turns it on.
 *
 *   * Only an owner grants it, for 1, 3, or 7 days. Owners and admins can
 *     end it early. Each change is in the workspace audit log.
 *   * Support staff are the profile ids in GROUNDWORKS_SUPPORT_USER_IDS.
 *     They need two-step verification in the current session, and get a
 *     read-only (viewer) seat in every company of the workspace while the
 *     grant is live. Expiry or revocation ends it on the next click.
 *   * Every time support opens the workspace, an audit row says so.
 */

export const SUPPORT_ACCESS_DAYS = [1, 3, 7] as const;

export const GrantSupportAccessSchema = z.object({
  days: z.union([z.literal(1), z.literal(3), z.literal(7)]),
});

/** Is this person on the Groundworks support team? */
export function isSupportStaff(userId: string): boolean {
  return (process.env.GROUNDWORKS_SUPPORT_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(userId.toLowerCase());
}

export type SupportWorkspace = { grantId: string; workspaceId: string; expiresAt: Date; workspace: Workspace };

/**
 * Workspaces this person can open as support right now: staff only, with
 * MFA used in this session, and only where a live grant exists.
 */
export async function supportWorkspacesFor(userId: string, aal: string): Promise<SupportWorkspace[]> {
  if (aal !== "aal2" || !isSupportStaff(userId)) return [];
  return db
    .select({
      grantId: supportAccessGrants.id,
      workspaceId: supportAccessGrants.workspaceId,
      expiresAt: supportAccessGrants.expiresAt,
      workspace: workspaces,
    })
    .from(supportAccessGrants)
    .innerJoin(workspaces, eq(workspaces.id, supportAccessGrants.workspaceId))
    .where(
      and(
        isNull(supportAccessGrants.revokedAt),
        gt(supportAccessGrants.expiresAt, sql`now()`),
        isNull(workspaces.deletedAt)
      )
    )
    .orderBy(workspaces.name);
}

/** Audit row in the customer's workspace: support opened it. */
export async function recordSupportOpened(userId: string, workspaceId: string, grantId: string, meta: RequestMeta) {
  await writeAudit({
    workspaceId,
    actorId: userId,
    event: "support_access.opened",
    entityType: "support_access_grant",
    entityId: grantId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}

export type SupportAccessView = {
  active: { id: string; expiresAt: Date; grantedBy: string | null } | null;
  /** Grants, revocations, and every time support opened the workspace. */
  history: Array<{ event: string; at: Date; who: string | null }>;
};

export async function getSupportAccess(ctx: WsCtx): Promise<SupportAccessView> {
  const [active] = await ctx.tx
    .select({ id: supportAccessGrants.id, expiresAt: supportAccessGrants.expiresAt, grantedBy: profiles.email })
    .from(supportAccessGrants)
    .leftJoin(profiles, eq(profiles.id, supportAccessGrants.grantedBy))
    .where(
      and(
        eq(supportAccessGrants.workspaceId, ctx.actor.workspaceId),
        isNull(supportAccessGrants.revokedAt),
        gt(supportAccessGrants.expiresAt, sql`now()`)
      )
    )
    .orderBy(desc(supportAccessGrants.expiresAt))
    .limit(1);
  const history = await ctx.tx
    .select({ event: auditLog.event, at: auditLog.occurredAt, who: profiles.email })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.id, auditLog.actorId))
    .where(and(eq(auditLog.workspaceId, ctx.actor.workspaceId), like(auditLog.event, "support_access.%")))
    .orderBy(desc(auditLog.occurredAt))
    .limit(25);
  return { active: active ?? null, history };
}

/** Turn support access on (or extend it). Owners only. */
export async function grantSupportAccess(
  ctx: WsCtx,
  input: z.input<typeof GrantSupportAccessSchema>
): Promise<{ id: string; expiresAt: Date }> {
  requireWorkspaceRole(ctx.actor, "owner", "allow Groundworks support access");
  const { days } = GrantSupportAccessSchema.parse(input);
  await endGrants(ctx);
  const [grant] = await ctx.tx
    .insert(supportAccessGrants)
    .values({
      workspaceId: ctx.actor.workspaceId,
      grantedBy: ctx.actor.userId,
      expiresAt: sql`now() + make_interval(days => ${days})`,
    })
    .returning({ id: supportAccessGrants.id, expiresAt: supportAccessGrants.expiresAt });
  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
      event: "support_access.granted",
      entityType: "support_access_grant",
      entityId: grant.id,
      metadata: { days, expiresAt: grant.expiresAt.toISOString() },
    },
    ctx.tx
  );
  return grant;
}

/** Turn support access off now. Owners and admins. */
export async function revokeSupportAccess(ctx: WsCtx): Promise<{ ended: number }> {
  requireWorkspaceRole(ctx.actor, "admin", "turn off Groundworks support access");
  const ended = await endGrants(ctx);
  if (ended > 0) {
    await writeAudit(
      { ...workspaceAuditFields(ctx.actor), event: "support_access.revoked", entityType: "workspace", entityId: ctx.actor.workspaceId },
      ctx.tx
    );
  }
  return { ended };
}

async function endGrants(ctx: WsCtx): Promise<number> {
  const rows = await ctx.tx
    .update(supportAccessGrants)
    .set({ revokedAt: sql`now()`, revokedBy: ctx.actor.userId })
    .where(
      and(
        eq(supportAccessGrants.workspaceId, ctx.actor.workspaceId),
        isNull(supportAccessGrants.revokedAt),
        gt(supportAccessGrants.expiresAt, sql`now()`)
      )
    )
    .returning({ id: supportAccessGrants.id });
  return rows.length;
}
