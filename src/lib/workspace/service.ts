import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accessReviews,
  agents,
  apiKeys,
  auditLog,
  invitations,
  membershipRole,
  memberships,
  organizations,
  profiles,
  userSessions,
  workspaceMembers,
  workspaceRole,
  workspaces,
  type InvitationGrant,
  type Workspace,
} from "@/lib/db/schema";
import {
  requireWorkspaceRole,
  workspaceAuditFields,
  type RequestMeta,
  type Role,
  type Tx,
  type WorkspaceRole,
  type WsCtx,
} from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { id, isoDate } from "@/lib/schemas";
import { seedOrganizationDefaults } from "@/lib/seed/org-defaults";
import { mfaStatus } from "@/lib/security/mfa";
import { randomSuffix, slugify } from "@/lib/slug";

/**
 * WORKSPACE — the account above the companies. Sign-up creates a workspace
 * and its first company; admins add companies, invite people once, and
 * decide which companies each person can open (and with what role).
 *
 * Guard rails:
 *   - only an owner can make, unmake, or invite an owner
 *   - the last active owner can't be demoted or removed
 *   - invitations honor the workspace's allowed email domains
 *   - removing someone from the workspace closes every company to them
 *     (and with it their personal API keys) on their next request
 */

const INVITE_TTL_DAYS = 7;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const companyName = z.string().trim().min(2, "Name must be at least 2 characters").max(100);

export const CompanySchema = z.object({
  name: companyName,
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(1),
  baseCurrency: z.string().trim().length(3).transform((s) => s.toUpperCase()).default("USD"),
  seedDefaultCoa: z.boolean().default(true),
});
export type CompanyInput = z.input<typeof CompanySchema>;

export const SignupSchema = CompanySchema.extend({
  /** Defaults to the company name. */
  workspaceName: z.string().trim().max(100).optional(),
  fullName: z.string().trim().max(100).optional(),
});
export type SignupInput = z.input<typeof SignupSchema>;

const grantSchema = z.object({
  organizationId: id,
  role: z.enum(membershipRole.enumValues),
});

export const InviteSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  workspaceRole: z.enum(workspaceRole.enumValues).default("member"),
  grants: z.array(grantSchema).max(200).default([]),
});
export type InviteInput = z.input<typeof InviteSchema>;

export const UpdatePersonSchema = z.object({
  userId: id,
  role: z.enum(workspaceRole.enumValues).optional(),
  isActive: z.boolean().optional(),
});

export const CompanyAccessSchema = z.object({
  userId: id,
  organizationId: id,
  /** null removes access to the company. */
  role: z.enum(membershipRole.enumValues).nullable(),
});

export const SecurityPolicySchema = z.object({
  requireMfa: z.boolean(),
  sessionIdleMinutes: z.coerce.number().int().min(5).max(24 * 60),
  sessionMaxHours: z.coerce.number().int().min(1).max(24 * 30),
  apiKeyMaxDays: z.coerce.number().int().min(1).max(3650).nullable(),
  allowedEmailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .transform((d) => d.replace(/^@/, ""))
        .pipe(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a domain like acme.com."))
    )
    .max(20),
});
export type SecurityPolicyInput = z.input<typeof SecurityPolicySchema>;
export type SecurityPolicy = z.output<typeof SecurityPolicySchema>;

// ---------------------------------------------------------------------------
// Creating workspaces and companies
// ---------------------------------------------------------------------------

async function uniqueSlug(tx: Tx, table: typeof workspaces | typeof organizations, name: string): Promise<string> {
  const base = slugify(name) || "company";
  for (let attempt = 0; attempt < 8; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    const [taken] = await tx.select({ id: table.id }).from(table).where(eq(table.slug, slug));
    if (!taken) return slug;
  }
  throw new AppError("conflict", "Could not find a free URL name. Try a different name.");
}

async function createCompanyIn(
  tx: Tx,
  workspaceId: string,
  userId: string,
  input: z.output<typeof CompanySchema>,
  audit: { requestId: string; ipAddress: string | null; userAgent: string | null }
): Promise<string> {
  const slug = await uniqueSlug(tx, organizations, input.name);
  const [org] = await tx
    .insert(organizations)
    .values({
      workspaceId,
      name: input.name,
      slug,
      baseCurrency: input.baseCurrency,
      fiscalYearStartMonth: input.fiscalYearStartMonth,
    })
    .returning({ id: organizations.id });
  await tx.insert(memberships).values({ organizationId: org.id, userId, role: "owner" });
  await seedOrganizationDefaults(tx, org.id, { includeDefaultCoa: input.seedDefaultCoa });
  await writeAudit(
    {
      organizationId: org.id,
      actorId: userId,
      ...audit,
      event: "organization.created",
      entityType: "organization",
      entityId: org.id,
      metadata: {
        name: input.name,
        slug,
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        baseCurrency: input.baseCurrency,
        seededCoa: input.seedDefaultCoa,
      },
    },
    tx
  );
  return org.id;
}

/**
 * Sign-up: a new workspace with its first company, the person as owner of
 * both. Also used when an existing user starts a separate workspace.
 */
export async function createWorkspace(
  tx: Tx,
  user: { id: string; email: string },
  input: SignupInput,
  meta: RequestMeta = { ipAddress: null, userAgent: null }
): Promise<{ workspaceId: string; organizationId: string }> {
  const d = SignupSchema.parse(input);
  await tx
    .insert(profiles)
    .values({ id: user.id, email: user.email, fullName: d.fullName || null })
    .onConflictDoNothing();
  if (d.fullName) {
    await tx
      .update(profiles)
      .set({ fullName: d.fullName, updatedAt: sql`now()` })
      .where(and(eq(profiles.id, user.id), isNull(profiles.fullName)));
  }

  const name = d.workspaceName || d.name;
  const [ws] = await tx
    .insert(workspaces)
    .values({ name, slug: await uniqueSlug(tx, workspaces, name), createdBy: user.id })
    .returning({ id: workspaces.id });
  await tx.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });

  const audit = { requestId: randomUUID(), ...meta };
  await writeAudit(
    {
      workspaceId: ws.id,
      actorId: user.id,
      ...audit,
      event: "workspace.created",
      entityType: "workspace",
      entityId: ws.id,
      metadata: { name },
    },
    tx
  );
  const organizationId = await createCompanyIn(tx, ws.id, user.id, d, audit);
  return { workspaceId: ws.id, organizationId };
}

/** Add a company to the workspace. The creator becomes its owner. */
export async function createCompany(ctx: WsCtx, input: CompanyInput): Promise<{ id: string }> {
  requireWorkspaceRole(ctx.actor, "admin", "add companies");
  const d = CompanySchema.parse(input);
  const { requestId, ipAddress, userAgent } = workspaceAuditFields(ctx.actor);
  return {
    id: await createCompanyIn(ctx.tx, ctx.actor.workspaceId, ctx.actor.userId, d, { requestId, ipAddress, userAgent }),
  };
}

export type CompanyRow = {
  id: string;
  name: string;
  slug: string;
  baseCurrency: string;
  createdAt: Date;
  /** The current user's role here, or null without access. */
  myRole: Role | null;
  people: number;
};

/** Admins see every company; members see the ones they can open. */
export async function listCompanies(ctx: WsCtx): Promise<CompanyRow[]> {
  const rows = await ctx.tx
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      baseCurrency: organizations.baseCurrency,
      createdAt: organizations.createdAt,
      myRole: sql<Role | null>`(
        SELECT m.role FROM memberships m
         WHERE m.organization_id = "organizations"."id" AND m.user_id = ${ctx.actor.userId}
           AND m.is_active AND m.deleted_at IS NULL)`,
      people: sql<number>`(
        SELECT count(*)::int FROM memberships m
         WHERE m.organization_id = "organizations"."id" AND m.is_active AND m.deleted_at IS NULL)`,
    })
    .from(organizations)
    .where(and(eq(organizations.workspaceId, ctx.actor.workspaceId), isNull(organizations.deletedAt)))
    .orderBy(asc(organizations.name));
  return ctx.actor.role === "member" ? rows.filter((r) => r.myRole) : rows;
}

export async function renameWorkspace(ctx: WsCtx, input: { name: string }): Promise<{ id: string }> {
  requireWorkspaceRole(ctx.actor, "admin", "rename the workspace");
  const name = companyName.parse(input.name);
  const [before] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  await ctx.tx
    .update(workspaces)
    .set({ name, updatedAt: sql`now()` })
    .where(eq(workspaces.id, ctx.actor.workspaceId));
  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
      event: "workspace.renamed",
      entityType: "workspace",
      entityId: ctx.actor.workspaceId,
      metadata: { before: before?.name, after: name },
    },
    ctx.tx
  );
  return { id: ctx.actor.workspaceId };
}

// ---------------------------------------------------------------------------
// People and company access
// ---------------------------------------------------------------------------

export type PersonRow = {
  userId: string;
  email: string;
  fullName: string | null;
  role: WorkspaceRole;
  isActive: boolean;
  joinedAt: Date;
  lastSeenAt: Date | null;
  /** null = unknown (auth schema not readable). */
  mfaEnabled: boolean | null;
  /** organizationId → role, active access only. */
  companies: Record<string, Role>;
};

export async function listPeople(ctx: WsCtx): Promise<PersonRow[]> {
  const ws = ctx.actor.workspaceId;
  const rows = await ctx.tx
    .select({
      userId: workspaceMembers.userId,
      email: profiles.email,
      fullName: profiles.fullName,
      role: workspaceMembers.role,
      isActive: workspaceMembers.isActive,
      joinedAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(profiles, eq(profiles.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, ws), isNull(workspaceMembers.deletedAt)))
    .orderBy(asc(profiles.email));
  const ids = rows.map((r) => r.userId);
  if (ids.length === 0) return [];

  const access = await ctx.tx
    .select({ userId: memberships.userId, organizationId: memberships.organizationId, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(organizations.workspaceId, ws),
        isNull(organizations.deletedAt),
        inArray(memberships.userId, ids),
        eq(memberships.isActive, true),
        isNull(memberships.deletedAt)
      )
    );
  const seen = await ctx.tx
    .select({ userId: userSessions.userId, at: max(userSessions.lastSeenAt) })
    .from(userSessions)
    .where(inArray(userSessions.userId, ids))
    .groupBy(userSessions.userId);
  const mfa = await mfaStatus(ctx.tx, ids);

  const lastSeen = new Map(seen.map((s) => [s.userId, s.at]));
  // Activity and MFA status are for admins (and your own row).
  const sees = (userId: string) => ctx.actor.role !== "member" || userId === ctx.actor.userId;
  return rows.map((r) => ({
    ...r,
    lastSeenAt: sees(r.userId) ? (lastSeen.get(r.userId) ?? null) : null,
    mfaEnabled: sees(r.userId) ? (mfa.get(r.userId) ?? null) : null,
    companies: Object.fromEntries(
      access.filter((a) => a.userId === r.userId).map((a) => [a.organizationId, a.role])
    ),
  }));
}

async function loadMember(ctx: WsCtx, userId: string) {
  const [m] = await ctx.tx
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.actor.workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt)
      )
    )
    .for("update");
  if (!m) throw notFound("Person");
  return m;
}

async function activeOwnerCount(tx: Tx, workspaceId: string): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "owner"),
        eq(workspaceMembers.isActive, true),
        isNull(workspaceMembers.deletedAt)
      )
    );
  return n;
}

/**
 * Change someone's workspace role, or remove / restore them. Removing
 * also closes every company in the workspace to them; restoring brings
 * back the workspace seat only (grant companies again explicitly).
 */
export async function updatePerson(
  ctx: WsCtx,
  input: z.input<typeof UpdatePersonSchema>
): Promise<{ userId: string }> {
  requireWorkspaceRole(ctx.actor, "admin", "change people's access");
  const d = UpdatePersonSchema.parse(input);
  const m = await loadMember(ctx, d.userId);
  const nextRole = d.role ?? m.role;
  const nextActive = d.isActive ?? m.isActive;

  if ((m.role === "owner" || nextRole === "owner") && ctx.actor.role !== "owner") {
    throw new AppError("forbidden", "Only an owner can grant or change the owner role.");
  }
  const losesOwner = m.role === "owner" && m.isActive && (nextRole !== "owner" || !nextActive);
  if (losesOwner && (await activeOwnerCount(ctx.tx, ctx.actor.workspaceId)) <= 1) {
    throw invalidState("Every workspace needs at least one active owner. Make someone else an owner first.");
  }

  await ctx.tx
    .update(workspaceMembers)
    .set({ role: nextRole, isActive: nextActive, updatedAt: sql`now()` })
    .where(eq(workspaceMembers.id, m.id));

  let companiesClosed = 0;
  if (m.isActive && !nextActive) {
    const closed = await ctx.tx
      .update(memberships)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(
        and(
          eq(memberships.userId, m.userId),
          eq(memberships.isActive, true),
          inArray(
            memberships.organizationId,
            ctx.tx
              .select({ id: organizations.id })
              .from(organizations)
              .where(eq(organizations.workspaceId, ctx.actor.workspaceId))
          )
        )
      )
      .returning({ id: memberships.id });
    companiesClosed = closed.length;
  }

  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
      event: m.isActive && !nextActive ? "workspace.member.removed" : !m.isActive && nextActive ? "workspace.member.restored" : "workspace.member.updated",
      entityType: "workspace_member",
      entityId: m.id,
      metadata: {
        userId: m.userId,
        before: { role: m.role, isActive: m.isActive },
        after: { role: nextRole, isActive: nextActive },
        ...(companiesClosed ? { companiesClosed } : {}),
      },
    },
    ctx.tx
  );
  return { userId: m.userId };
}

/** Open, change, or close one company for one person. */
export async function setCompanyAccess(
  ctx: WsCtx,
  input: z.input<typeof CompanyAccessSchema>
): Promise<{ userId: string; organizationId: string; role: Role | null }> {
  requireWorkspaceRole(ctx.actor, "admin", "change company access");
  const d = CompanyAccessSchema.parse(input);
  const m = await loadMember(ctx, d.userId);
  if (m.role === "owner" && ctx.actor.role !== "owner" && m.userId !== ctx.actor.userId) {
    throw new AppError("forbidden", "Only an owner can change a workspace owner's company access.");
  }
  if (!m.isActive && d.role) {
    throw invalidState("This person was removed from the workspace. Restore them before granting access.");
  }
  const [org] = await ctx.tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, d.organizationId),
        eq(organizations.workspaceId, ctx.actor.workspaceId),
        isNull(organizations.deletedAt)
      )
    );
  if (!org) throw notFound("Company");

  const [existing] = await ctx.tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.organizationId, org.id), eq(memberships.userId, d.userId)))
    .for("update");
  const before = existing && existing.isActive && !existing.deletedAt ? existing.role : null;
  if (before === d.role) return { userId: d.userId, organizationId: org.id, role: d.role };

  if (d.role) {
    await ctx.tx
      .insert(memberships)
      .values({ organizationId: org.id, userId: d.userId, role: d.role, invitedBy: ctx.actor.userId })
      .onConflictDoUpdate({
        target: [memberships.organizationId, memberships.userId],
        set: { role: d.role, isActive: true, deletedAt: null, updatedAt: sql`now()` },
      });
  } else if (existing) {
    await ctx.tx
      .update(memberships)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(eq(memberships.id, existing.id));
  }

  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
      organizationId: org.id,
      event: !before ? "membership.granted" : !d.role ? "membership.revoked" : "membership.updated",
      entityType: "membership",
      entityId: existing?.id ?? null,
      metadata: { userId: d.userId, company: org.name, before, after: d.role },
    },
    ctx.tx
  );
  return { userId: d.userId, organizationId: org.id, role: d.role };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type InvitationRow = {
  id: string;
  email: string;
  workspaceRole: WorkspaceRole;
  grants: InvitationGrant[];
  expiresAt: Date;
  createdAt: Date;
  invitedByEmail: string | null;
};

export async function listInvitations(ctx: WsCtx): Promise<InvitationRow[]> {
  requireWorkspaceRole(ctx.actor, "admin", "see invitations");
  return ctx.tx
    .select({
      id: invitations.id,
      email: invitations.email,
      workspaceRole: invitations.workspaceRole,
      grants: invitations.grants,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      invitedByEmail: profiles.email,
    })
    .from(invitations)
    .leftJoin(profiles, eq(profiles.id, invitations.invitedBy))
    .where(
      and(
        eq(invitations.workspaceId, ctx.actor.workspaceId),
        isNull(invitations.acceptedAt),
        isNull(invitations.deletedAt)
      )
    )
    .orderBy(desc(invitations.createdAt));
}

/**
 * Invite someone (or refresh their pending invite) with a workspace role
 * and company access. Returns the plaintext token once; the link is
 * `${origin}/invite/${token}`. Sending the email is the caller's job,
 * after this transaction commits.
 */
export async function createInvitation(
  ctx: WsCtx,
  input: InviteInput
): Promise<{ invitation: InvitationRow; token: string; workspaceName: string; companyNames: string[] }> {
  requireWorkspaceRole(ctx.actor, "admin", "invite people");
  const d = InviteSchema.parse(input);
  const ws = ctx.actor.workspaceId;
  if (d.workspaceRole === "owner" && ctx.actor.role !== "owner") {
    throw new AppError("forbidden", "Only an owner can invite another owner.");
  }

  const [workspace] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ws));
  const domains = workspace.allowedEmailDomains ?? [];
  const domain = d.email.split("@")[1];
  if (domains.length > 0 && !domains.includes(domain)) {
    throw new AppError(
      "forbidden",
      `This workspace only allows invitations to ${domains.map((x) => `@${x}`).join(", ")}. Change that under Workspace → Security.`
    );
  }

  const grants = Array.from(new Map(d.grants.map((g) => [g.organizationId, g])).values());
  const companies = grants.length
    ? await ctx.tx
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(
          and(
            eq(organizations.workspaceId, ws),
            isNull(organizations.deletedAt),
            inArray(organizations.id, grants.map((g) => g.organizationId))
          )
        )
    : [];
  if (companies.length !== grants.length) throw notFound("Company");

  const [existing] = await ctx.tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(profiles, eq(profiles.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, ws),
        sql`lower(${profiles.email}) = ${d.email}`,
        eq(workspaceMembers.isActive, true),
        isNull(workspaceMembers.deletedAt)
      )
    );
  if (existing) {
    throw new AppError("conflict", `${d.email} is already in this workspace. Change their access on the People page instead.`);
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = sql`now() + make_interval(days => ${INVITE_TTL_DAYS})`;
  const [pending] = await ctx.tx
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, ws),
        eq(invitations.email, d.email),
        isNull(invitations.acceptedAt),
        isNull(invitations.deletedAt)
      )
    );
  const values = {
    workspaceRole: d.workspaceRole,
    grants,
    token: hashToken(token),
    invitedBy: ctx.actor.userId,
    expiresAt,
  };
  const [row] = pending
    ? await ctx.tx
        .update(invitations)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(invitations.id, pending.id))
        .returning()
    : await ctx.tx
        .insert(invitations)
        .values({ workspaceId: ws, email: d.email, ...values })
        .returning();

  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
      event: pending ? "invitation.refreshed" : "invitation.created",
      entityType: "invitation",
      entityId: row.id,
      metadata: { email: d.email, workspaceRole: d.workspaceRole, grants },
    },
    ctx.tx
  );
  const [inviter] = await ctx.tx.select({ email: profiles.email }).from(profiles).where(eq(profiles.id, ctx.actor.userId));
  return {
    invitation: {
      id: row.id,
      email: row.email,
      workspaceRole: row.workspaceRole,
      grants: row.grants,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      invitedByEmail: inviter?.email ?? null,
    },
    token,
    workspaceName: workspace.name,
    companyNames: companies.map((c) => c.name),
  };
}

export async function revokeInvitation(ctx: WsCtx, input: { id: string }): Promise<{ id: string }> {
  requireWorkspaceRole(ctx.actor, "admin", "revoke invitations");
  const invitationId = id.parse(input.id);
  const [row] = await ctx.tx
    .update(invitations)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.workspaceId, ctx.actor.workspaceId),
        isNull(invitations.acceptedAt),
        isNull(invitations.deletedAt)
      )
    )
    .returning();
  if (!row) throw notFound("Invitation");
  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
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
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  workspaceRole: WorkspaceRole;
  /** Grants for companies that still exist, with their names. */
  grants: Array<InvitationGrant & { companyName: string }>;
};

/** Look up a live invite by its plaintext token (for the accept page). */
export async function findInvitation(tx: Tx, token: string): Promise<InvitationPreview | null> {
  const [row] = await tx
    .select({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
      workspaceName: workspaces.name,
      email: invitations.email,
      workspaceRole: invitations.workspaceRole,
      grants: invitations.grants,
    })
    .from(invitations)
    .innerJoin(workspaces, and(eq(workspaces.id, invitations.workspaceId), isNull(workspaces.deletedAt)))
    .where(
      and(
        eq(invitations.token, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.deletedAt),
        gt(invitations.expiresAt, sql`now()`)
      )
    );
  if (!row) return null;
  const ids = row.grants.map((g) => g.organizationId);
  const companies = ids.length
    ? await tx
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(and(inArray(organizations.id, ids), eq(organizations.workspaceId, row.workspaceId), isNull(organizations.deletedAt)))
    : [];
  const names = new Map(companies.map((c) => [c.id, c.name]));
  return {
    ...row,
    grants: row.grants
      .filter((g) => names.has(g.organizationId))
      .map((g) => ({ ...g, companyName: names.get(g.organizationId)! })),
  };
}

/**
 * Accept an invite as the signed-in user. The user's email must match the
 * invited address, so a forwarded link can't be used by someone else.
 * Returns the first company opened (if any) so the UI can land there.
 */
export async function acceptInvitation(
  tx: Tx,
  user: { id: string; email: string },
  token: string,
  meta: RequestMeta = { ipAddress: null, userAgent: null }
): Promise<{ workspaceId: string; organizationId: string | null }> {
  const inv = await findInvitation(tx, token);
  if (!inv) throw new AppError("not_found", "This invitation is invalid, expired, or already used.");
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError("forbidden", `This invitation is for ${inv.email}. Sign in with that address to accept it.`);
  }

  await tx.insert(profiles).values({ id: user.id, email: user.email }).onConflictDoNothing();
  const [inviter] = await tx.select({ invitedBy: invitations.invitedBy }).from(invitations).where(eq(invitations.id, inv.id));
  await tx
    .insert(workspaceMembers)
    .values({ workspaceId: inv.workspaceId, userId: user.id, role: inv.workspaceRole, invitedBy: inviter?.invitedBy ?? null })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: inv.workspaceRole, isActive: true, deletedAt: null, updatedAt: sql`now()` },
    });
  for (const g of inv.grants) {
    await tx
      .insert(memberships)
      .values({ organizationId: g.organizationId, userId: user.id, role: g.role, invitedBy: inviter?.invitedBy ?? null })
      .onConflictDoUpdate({
        target: [memberships.organizationId, memberships.userId],
        set: { role: g.role, isActive: true, deletedAt: null, updatedAt: sql`now()` },
      });
  }
  await tx
    .update(invitations)
    .set({ acceptedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(invitations.id, inv.id));
  await writeAudit(
    {
      workspaceId: inv.workspaceId,
      actorId: user.id,
      requestId: randomUUID(),
      ...meta,
      event: "invitation.accepted",
      entityType: "invitation",
      entityId: inv.id,
      metadata: {
        email: inv.email,
        workspaceRole: inv.workspaceRole,
        grants: inv.grants.map(({ organizationId, role }) => ({ organizationId, role })),
      },
    },
    tx
  );
  return { workspaceId: inv.workspaceId, organizationId: inv.grants[0]?.organizationId ?? null };
}

// ---------------------------------------------------------------------------
// Security policy
// ---------------------------------------------------------------------------

function policyOf(w: Workspace): SecurityPolicy {
  return {
    requireMfa: w.requireMfa,
    sessionIdleMinutes: w.sessionIdleMinutes,
    sessionMaxHours: w.sessionMaxHours,
    apiKeyMaxDays: w.apiKeyMaxDays,
    allowedEmailDomains: w.allowedEmailDomains ?? [],
  };
}

export async function getSecurityPolicy(ctx: WsCtx): Promise<SecurityPolicy> {
  const [w] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  if (!w) throw notFound("Workspace");
  return policyOf(w);
}

export async function updateSecurityPolicy(ctx: WsCtx, input: SecurityPolicyInput): Promise<SecurityPolicy> {
  requireWorkspaceRole(ctx.actor, "admin", "change the security policy");
  const d = SecurityPolicySchema.parse(input);
  if (d.sessionIdleMinutes > d.sessionMaxHours * 60) {
    throw new AppError("invalid_input", "The idle timeout can't be longer than the maximum session length.");
  }
  const before = await getSecurityPolicy(ctx);
  const [w] = await ctx.tx
    .update(workspaces)
    .set({
      requireMfa: d.requireMfa,
      sessionIdleMinutes: d.sessionIdleMinutes,
      sessionMaxHours: d.sessionMaxHours,
      apiKeyMaxDays: d.apiKeyMaxDays,
      allowedEmailDomains: d.allowedEmailDomains.length ? Array.from(new Set(d.allowedEmailDomains)) : null,
      updatedAt: sql`now()`,
    })
    .where(eq(workspaces.id, ctx.actor.workspaceId))
    .returning();
  const after = policyOf(w);
  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
      event: "workspace.security_policy.updated",
      entityType: "workspace",
      entityId: w.id,
      metadata: { before, after },
    },
    ctx.tx
  );
  return after;
}

// ---------------------------------------------------------------------------
// Access reviews
// ---------------------------------------------------------------------------

export type AccessSnapshot = {
  takenAt: string;
  companies: Array<{ id: string; name: string }>;
  people: Array<{
    userId: string;
    email: string;
    name: string | null;
    workspaceRole: WorkspaceRole;
    active: boolean;
    mfa: boolean | null;
    lastSeenAt: string | null;
    companies: Array<{ company: string; role: Role }>;
  }>;
  agents: Array<{
    id: string;
    company: string;
    name: string;
    role: Role;
    autonomy: string;
    maxPostAmount: string | null;
    active: boolean;
    lastActiveAt: string | null;
  }>;
  apiKeys: Array<{
    id: string;
    company: string;
    name: string;
    prefix: string;
    owner: string;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
  }>;
};

/** Who can reach what, right now: the thing a reviewer signs off on. */
export async function accessSnapshot(ctx: WsCtx): Promise<AccessSnapshot> {
  requireWorkspaceRole(ctx.actor, "admin", "review access");
  const ws = ctx.actor.workspaceId;
  const companies = await ctx.tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.workspaceId, ws), isNull(organizations.deletedAt)))
    .orderBy(asc(organizations.name));
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const people = await listPeople(ctx);

  const agentRows = companies.length
    ? await ctx.tx
        .select()
        .from(agents)
        .where(and(inArray(agents.organizationId, companies.map((c) => c.id)), isNull(agents.deletedAt)))
        .orderBy(asc(agents.name))
    : [];
  const keyRows = companies.length
    ? await ctx.tx
        .select({
          key: apiKeys,
          agentName: agents.name,
          userEmail: profiles.email,
        })
        .from(apiKeys)
        .leftJoin(agents, eq(agents.id, apiKeys.agentId))
        .leftJoin(profiles, eq(profiles.id, apiKeys.userId))
        .where(
          and(
            inArray(apiKeys.organizationId, companies.map((c) => c.id)),
            isNull(apiKeys.revokedAt),
            isNull(apiKeys.deletedAt),
            sql`(${apiKeys.expiresAt} IS NULL OR ${apiKeys.expiresAt} > now())`
          )
        )
        .orderBy(asc(apiKeys.name))
    : [];

  return {
    takenAt: new Date().toISOString(),
    companies,
    people: people.map((p) => ({
      userId: p.userId,
      email: p.email,
      name: p.fullName,
      workspaceRole: p.role,
      active: p.isActive,
      mfa: p.mfaEnabled,
      lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
      companies: Object.entries(p.companies).map(([orgId, role]) => ({ company: companyName.get(orgId) ?? orgId, role })),
    })),
    agents: agentRows.map((a) => ({
      id: a.id,
      company: companyName.get(a.organizationId) ?? a.organizationId,
      name: a.name,
      role: a.role,
      autonomy: a.autonomy,
      maxPostAmount: a.maxPostAmount,
      active: a.isActive,
      lastActiveAt: a.lastActiveAt?.toISOString() ?? null,
    })),
    apiKeys: keyRows.map(({ key, agentName, userEmail }) => ({
      id: key.id,
      company: companyName.get(key.organizationId) ?? key.organizationId,
      name: key.name,
      prefix: key.prefix,
      owner: agentName ? `agent: ${agentName}` : `person: ${userEmail ?? key.userId}`,
      scopes: key.scopes,
      expiresAt: key.expiresAt?.toISOString() ?? null,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    })),
  };
}

export const AccessReviewSchema = z.object({ notes: z.string().trim().max(4000).optional() });

/** Record that an admin reviewed everyone's access, with the evidence frozen. */
export async function completeAccessReview(
  ctx: WsCtx,
  input: z.input<typeof AccessReviewSchema>
): Promise<{ id: string }> {
  const d = AccessReviewSchema.parse(input);
  const snapshot = await accessSnapshot(ctx);
  const [row] = await ctx.tx
    .insert(accessReviews)
    .values({ workspaceId: ctx.actor.workspaceId, reviewedBy: ctx.actor.userId, notes: d.notes || null, snapshot })
    .returning({ id: accessReviews.id });
  await writeAudit(
    {
      ...workspaceAuditFields(ctx.actor),
      event: "workspace.access_review.completed",
      entityType: "access_review",
      entityId: row.id,
      metadata: {
        people: snapshot.people.length,
        agents: snapshot.agents.length,
        apiKeys: snapshot.apiKeys.length,
      },
    },
    ctx.tx
  );
  return { id: row.id };
}

export async function listAccessReviews(ctx: WsCtx) {
  requireWorkspaceRole(ctx.actor, "admin", "see access reviews");
  return ctx.tx
    .select({
      id: accessReviews.id,
      completedAt: accessReviews.completedAt,
      notes: accessReviews.notes,
      reviewerEmail: profiles.email,
      people: sql<number>`jsonb_array_length(${accessReviews.snapshot}->'people')`,
      agents: sql<number>`jsonb_array_length(${accessReviews.snapshot}->'agents')`,
      apiKeys: sql<number>`jsonb_array_length(${accessReviews.snapshot}->'apiKeys')`,
    })
    .from(accessReviews)
    .leftJoin(profiles, eq(profiles.id, accessReviews.reviewedBy))
    .where(eq(accessReviews.workspaceId, ctx.actor.workspaceId))
    .orderBy(desc(accessReviews.completedAt));
}

export async function getAccessReview(ctx: WsCtx, input: { id: string }) {
  requireWorkspaceRole(ctx.actor, "admin", "see access reviews");
  const [row] = await ctx.tx
    .select()
    .from(accessReviews)
    .where(and(eq(accessReviews.id, id.parse(input.id)), eq(accessReviews.workspaceId, ctx.actor.workspaceId)));
  if (!row) throw notFound("Access review");
  return { ...row, snapshot: row.snapshot as AccessSnapshot };
}

// ---------------------------------------------------------------------------
// Workspace audit log
// ---------------------------------------------------------------------------

export const AuditQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  organizationId: id.optional(),
  /** Event prefix, e.g. "auth." or "workspace.". */
  event: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(10000).default(200),
});

/** Everything that happened in the workspace, every company included. */
export async function listWorkspaceAudit(ctx: WsCtx, input: z.input<typeof AuditQuerySchema>) {
  requireWorkspaceRole(ctx.actor, "admin", "read the workspace audit log");
  const d = AuditQuerySchema.parse(input);
  const conds = [eq(auditLog.workspaceId, ctx.actor.workspaceId)];
  if (d.from) conds.push(gte(auditLog.occurredAt, sql`${d.from}::date`));
  if (d.to) conds.push(lt(auditLog.occurredAt, sql`${d.to}::date + 1`));
  if (d.organizationId) conds.push(eq(auditLog.organizationId, d.organizationId));
  if (d.event) conds.push(sql`${auditLog.event} LIKE ${d.event.replace(/[\\%_]/g, (c) => `\\${c}`) + "%"}`);
  return ctx.tx
    .select({
      id: auditLog.id,
      occurredAt: auditLog.occurredAt,
      event: auditLog.event,
      company: organizations.name,
      actorType: auditLog.actorType,
      actorEmail: profiles.email,
      agentName: agents.name,
      apiKeyId: auditLog.apiKeyId,
      channel: auditLog.channel,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      ipAddress: sql<string | null>`host(${auditLog.ipAddress})`,
      userAgent: auditLog.userAgent,
      requestId: auditLog.requestId,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .leftJoin(organizations, eq(organizations.id, auditLog.organizationId))
    .leftJoin(profiles, eq(profiles.id, auditLog.actorId))
    .leftJoin(agents, eq(agents.id, auditLog.agentId))
    .where(and(...conds))
    .orderBy(desc(auditLog.occurredAt))
    .limit(d.limit);
}
