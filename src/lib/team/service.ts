import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  invitations,
  membershipRole,
  memberships,
  organizations,
  profiles,
  type Invitation,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx, type Tx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { id } from "@/lib/schemas";

/**
 * TEAM — people in the org and invitations to join it. Admin-only, with
 * two guard rails: only an owner can make (or unmake) an owner, and the
 * last active owner can't be demoted or deactivated.
 *
 * Invitation links carry a random token; only its SHA-256 is stored, so a
 * database reader (or a member browsing via the Supabase API) can't lift a
 * working link. Lost the link? Regenerate it.
 */

const INVITE_TTL_DAYS = 7;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const InviteSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  role: z.enum(membershipRole.enumValues).default("bookkeeper"),
});
export type InviteInput = z.input<typeof InviteSchema>;

export const UpdateMemberSchema = z.object({
  membershipId: id,
  role: z.enum(membershipRole.enumValues).optional(),
  isActive: z.boolean().optional(),
});

export type MemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: (typeof membershipRole.enumValues)[number];
  isActive: boolean;
  joinedAt: Date;
};

export async function listMembers(ctx: Ctx): Promise<MemberRow[]> {
  requirePermission(ctx.actor, "read", "viewer", "list team members");
  return ctx.tx
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      email: profiles.email,
      fullName: profiles.fullName,
      role: memberships.role,
      isActive: memberships.isActive,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(profiles, eq(profiles.id, memberships.userId))
    .where(and(eq(memberships.organizationId, ctx.actor.organizationId), isNull(memberships.deletedAt)))
    .orderBy(asc(profiles.email));
}

async function activeOwnerCount(tx: Tx, organizationId: string): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, "owner"),
        eq(memberships.isActive, true),
        isNull(memberships.deletedAt)
      )
    );
  return n;
}

export async function updateMember(
  ctx: Ctx,
  input: z.input<typeof UpdateMemberSchema>
): Promise<MemberRow> {
  requirePermission(ctx.actor, "admin", "admin", "change team members");
  const d = UpdateMemberSchema.parse(input);
  const org = ctx.actor.organizationId;
  const [m] = await ctx.tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, d.membershipId), eq(memberships.organizationId, org)))
    .for("update");
  if (!m) throw notFound("Member");

  const touchesOwner = m.role === "owner" || d.role === "owner";
  if (touchesOwner && ctx.actor.role !== "owner") {
    throw new AppError("forbidden", "Only an owner can grant or change the owner role.");
  }
  const losesOwner =
    m.role === "owner" && m.isActive && ((d.role && d.role !== "owner") || d.isActive === false);
  if (losesOwner && (await activeOwnerCount(ctx.tx, org)) <= 1) {
    throw invalidState("Every organization needs at least one active owner. Promote someone else first.");
  }

  await ctx.tx
    .update(memberships)
    .set({
      role: d.role ?? m.role,
      isActive: d.isActive ?? m.isActive,
      updatedAt: sql`now()`,
    })
    .where(eq(memberships.id, m.id));

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: d.isActive === false ? "membership.deactivated" : "membership.updated",
      entityType: "membership",
      entityId: m.id,
      metadata: {
        userId: m.userId,
        before: { role: m.role, isActive: m.isActive },
        after: { role: d.role ?? m.role, isActive: d.isActive ?? m.isActive },
      },
    },
    ctx.tx
  );
  const row = (await listMembers(ctx)).find((r) => r.membershipId === m.id);
  return row!;
}

export type InvitationRow = Omit<Invitation, "token">;

export async function listInvitations(ctx: Ctx): Promise<InvitationRow[]> {
  requirePermission(ctx.actor, "admin", "admin", "list invitations");
  const rows = await ctx.tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, ctx.actor.organizationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.deletedAt)
      )
    )
    .orderBy(desc(invitations.createdAt));
  return rows.map(({ token: _token, ...rest }) => {
    void _token;
    return rest;
  });
}

/**
 * Invite someone (or refresh an existing pending invite). Returns the
 * plaintext token once; build the link as `${origin}/invite/${token}`.
 */
export async function createInvitation(
  ctx: Ctx,
  input: InviteInput
): Promise<{ invitation: InvitationRow; token: string }> {
  requirePermission(ctx.actor, "admin", "admin", "invite people");
  const d = InviteSchema.parse(input);
  const org = ctx.actor.organizationId;
  if (d.role === "owner" && ctx.actor.role !== "owner") {
    throw new AppError("forbidden", "Only an owner can invite another owner.");
  }

  const [existingMember] = await ctx.tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(profiles, eq(profiles.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, org),
        sql`lower(${profiles.email}) = ${d.email}`,
        isNull(memberships.deletedAt)
      )
    );
  if (existingMember) {
    throw new AppError("conflict", `${d.email} is already a member. Change their role on the team page instead.`);
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = sql`now() + make_interval(days => ${INVITE_TTL_DAYS})`;

  // One live invite per (org, email): refresh it rather than stacking.
  const [pending] = await ctx.tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, org),
        eq(invitations.email, d.email),
        isNull(invitations.acceptedAt),
        isNull(invitations.deletedAt)
      )
    );
  const [row] = pending
    ? await ctx.tx
        .update(invitations)
        .set({ token: hashToken(token), role: d.role, expiresAt, invitedBy: ctx.actor.userId, updatedAt: sql`now()` })
        .where(eq(invitations.id, pending.id))
        .returning()
    : await ctx.tx
        .insert(invitations)
        .values({
          organizationId: org,
          email: d.email,
          role: d.role,
          token: hashToken(token),
          invitedBy: ctx.actor.userId,
          expiresAt,
        })
        .returning();

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: pending ? "invitation.refreshed" : "invitation.created",
      entityType: "invitation",
      entityId: row.id,
      metadata: { email: d.email, role: d.role },
    },
    ctx.tx
  );
  const { token: _hash, ...invitation } = row;
  void _hash;
  return { invitation, token };
}

export async function revokeInvitation(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "admin", "admin", "revoke invitations");
  const invitationId = id.parse(input.id);
  const [row] = await ctx.tx
    .update(invitations)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.organizationId, ctx.actor.organizationId),
        isNull(invitations.acceptedAt)
      )
    )
    .returning();
  if (!row) throw notFound("Invitation");
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "invitation.revoked",
      entityType: "invitation",
      entityId: row.id,
      metadata: { email: row.email },
    },
    ctx.tx
  );
  return { id: row.id };
}

export type InvitationPreview = {
  organizationId: string;
  organizationName: string;
  email: string;
  role: string;
};

/** Look up a live invite by its plaintext token (for the accept page). */
export async function findInvitation(tx: Tx, token: string): Promise<(InvitationPreview & { id: string }) | null> {
  const [row] = await tx
    .select({
      id: invitations.id,
      organizationId: invitations.organizationId,
      organizationName: organizations.name,
      email: invitations.email,
      role: invitations.role,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .where(
      and(
        eq(invitations.token, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.deletedAt),
        gt(invitations.expiresAt, sql`now()`)
      )
    );
  return row ?? null;
}

/**
 * Accept an invite as the signed-in user. The user's email must match the
 * invited address, so a forwarded link can't be used by someone else.
 */
export async function acceptInvitation(
  tx: Tx,
  user: { id: string; email: string },
  token: string
): Promise<{ organizationId: string }> {
  const inv = await findInvitation(tx, token);
  if (!inv) throw new AppError("not_found", "This invitation is invalid, expired, or already used.");
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError(
      "forbidden",
      `This invitation is for ${inv.email}. Sign in with that address to accept it.`
    );
  }

  await tx.insert(profiles).values({ id: user.id, email: user.email }).onConflictDoNothing();
  await tx
    .insert(memberships)
    .values({ organizationId: inv.organizationId, userId: user.id, role: inv.role as MemberRow["role"] })
    .onConflictDoUpdate({
      target: [memberships.organizationId, memberships.userId],
      set: { role: inv.role as MemberRow["role"], isActive: true, deletedAt: null, updatedAt: sql`now()` },
    });
  await tx
    .update(invitations)
    .set({ acceptedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(invitations.id, inv.id));
  await writeAudit(
    {
      organizationId: inv.organizationId,
      actorId: user.id,
      event: "invitation.accepted",
      entityType: "invitation",
      entityId: inv.id,
      metadata: { email: inv.email, role: inv.role },
    },
    tx
  );
  return { organizationId: inv.organizationId };
}
