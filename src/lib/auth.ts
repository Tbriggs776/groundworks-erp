import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memberships, organizations, workspaceMembers, workspaces } from "@/lib/db/schema";
import {
  hasRole,
  hasWorkspaceRole,
  requestMeta,
  userActor,
  workspaceActor,
  type Actor,
  type RequestMeta,
  type Role,
  type WorkspaceActor,
  type WorkspaceRole,
} from "@/lib/actor";
import { checkSession, type SessionVerdict } from "@/lib/security/sessions";
import { supportWorkspacesFor } from "@/lib/security/support";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side auth helpers for Server Components and Server Actions.
 *
 * Two layers:
 *   1. Supabase proves who someone is (a verified JWT, via getClaims).
 *   2. checkSession decides whether that session is still acceptable under
 *      the person's workspace policy: not revoked, not idle too long, not
 *      too old, MFA used when required. `requireUser` enforces both; only
 *      the sign-in, MFA, and sign-out pages use `getUser` alone.
 *
 * React's `cache` memoizes these within a request.
 */

export type SessionUser = {
  id: string;
  email: string;
  /** Supabase session id (JWT `session_id`). */
  sessionId: string | null;
  /** aal1 = one factor; aal2 = MFA used in this session. */
  aal: string;
  authenticatedAt: Date;
  methods: string[];
};

type AmrEntry = { method?: string; timestamp?: number };

/** The verified Supabase identity, or null when signed out. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const c = data?.claims;
  if (error || !c?.sub || typeof c.email !== "string" || !c.email) return null;
  const amr = (Array.isArray(c.amr) ? c.amr : []) as AmrEntry[];
  const firstFactorAt = amr
    .filter((a) => a.method !== "totp" && typeof a.timestamp === "number")
    .map((a) => a.timestamp as number);
  return {
    id: c.sub,
    email: c.email,
    sessionId: typeof c.session_id === "string" ? c.session_id : null,
    aal: typeof c.aal === "string" ? c.aal : "aal1",
    authenticatedAt: firstFactorAt.length ? new Date(Math.min(...firstFactorAt) * 1000) : new Date(),
    methods: amr.map((a) => a.method ?? "unknown"),
  };
});

export const getRequestMeta = cache(async (): Promise<RequestMeta> => requestMeta(await headers()));

/** Policy verdict for the current session (recorded on first sight). */
export const getSessionVerdict = cache(async (): Promise<SessionVerdict | null> => {
  const user = await getUser();
  if (!user?.sessionId) return null;
  return checkSession(
    {
      userId: user.id,
      sessionId: user.sessionId,
      aal: user.aal,
      authenticatedAt: user.authenticatedAt,
      methods: user.methods,
    },
    await getRequestMeta()
  );
});

/**
 * Route guard: the signed-in user whose session passes policy. Otherwise
 * redirects to sign-in, to a forced sign-out (with the reason), or to the
 * MFA step.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/auth/login");
  const verdict = await getSessionVerdict();
  if (verdict && !verdict.ok) {
    if (verdict.reason === "mfa_required") redirect("/auth/mfa");
    redirect(`/auth/signout?reason=${verdict.reason}`);
  }
  return user;
}

// ---------------------------------------------------------------------------
// Workspaces and companies the user can reach
// ---------------------------------------------------------------------------

/** Set when the access comes from an owner's support grant, not a seat. */
export type SupportVia = { grantId: string; expiresAt: Date };

export type WorkspaceMembership = {
  workspaceId: string;
  role: WorkspaceRole;
  workspace: typeof workspaces.$inferSelect;
  support?: SupportVia;
};

/** Workspaces Groundworks support may open right now (none for everyone else). */
const getSupportWorkspaces = cache(async () => {
  const user = await getUser();
  return user ? supportWorkspacesFor(user.id, user.aal) : [];
});

export const getUserWorkspaces = cache(async (): Promise<WorkspaceMembership[]> => {
  const user = await getUser();
  if (!user) return [];
  const own = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, user.id),
        eq(workspaceMembers.isActive, true),
        isNull(workspaceMembers.deletedAt),
        isNull(workspaces.deletedAt)
      )
    )
    .orderBy(asc(workspaces.name));
  const support = (await getSupportWorkspaces())
    .filter((g) => !own.some((w) => w.workspaceId === g.workspaceId))
    .map((g): WorkspaceMembership => ({
      workspaceId: g.workspaceId,
      role: "member",
      workspace: g.workspace,
      support: { grantId: g.grantId, expiresAt: g.expiresAt },
    }));
  return [...own, ...support];
});

export type MembershipWithOrg = {
  membershipId: string;
  organizationId: string;
  role: Role;
  organization: typeof organizations.$inferSelect;
  support?: SupportVia;
};

/**
 * Companies the user can open: an active company membership AND an active
 * seat in that company's workspace (removing someone from a workspace
 * closes all its companies at once).
 */
export const getUserMemberships = cache(async (): Promise<MembershipWithOrg[]> => {
  const user = await getUser();
  if (!user) return [];
  const own = await db
    .select({
      membershipId: memberships.id,
      organizationId: memberships.organizationId,
      role: memberships.role,
      organization: organizations,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, organizations.workspaceId),
        eq(workspaceMembers.userId, memberships.userId),
        eq(workspaceMembers.isActive, true),
        isNull(workspaceMembers.deletedAt)
      )
    )
    .where(
      and(
        eq(memberships.userId, user.id),
        eq(memberships.isActive, true),
        isNull(memberships.deletedAt),
        isNull(organizations.deletedAt)
      )
    )
    .orderBy(asc(organizations.name));
  // Support: a read-only seat in every company of a granted workspace.
  const grants = (await getUserWorkspaces()).filter((w) => w.support);
  if (grants.length === 0) return own;
  const companies = await db
    .select()
    .from(organizations)
    .where(and(inArray(organizations.workspaceId, grants.map((g) => g.workspaceId)), isNull(organizations.deletedAt)))
    .orderBy(asc(organizations.name));
  return [
    ...own,
    ...companies.map((organization): MembershipWithOrg => {
      const via = grants.find((g) => g.workspaceId === organization.workspaceId)!.support!;
      return { membershipId: via.grantId, organizationId: organization.id, role: "viewer", organization, support: via };
    }),
  ];
});

/** Cookie holding the company the user last switched to. */
export const ACTIVE_ORG_COOKIE = "gw_org";
/** Cookie holding the workspace the user last switched to (for workspace pages). */
export const ACTIVE_WORKSPACE_COOKIE = "gw_ws";

/**
 * The active workspace: the workspace cookie when still valid, else the
 * workspace of the company cookie, else the first company's, else the
 * first workspace. Cookies are only preferences; access is re-checked.
 */
export const getCurrentWorkspace = cache(async (): Promise<WorkspaceMembership | null> => {
  const all = await getUserWorkspaces();
  if (all.length === 0) return null;
  const jar = await cookies();
  const companies = await getUserMemberships();
  const preferredOrg = companies.find((m) => m.organizationId === jar.get(ACTIVE_ORG_COOKIE)?.value);
  const pick = (id: string | undefined) => (id ? all.find((w) => w.workspaceId === id) : undefined);
  return (
    pick(jar.get(ACTIVE_WORKSPACE_COOKIE)?.value) ??
    pick(preferredOrg?.organization.workspaceId) ??
    pick(companies[0]?.organization.workspaceId) ??
    all[0]
  );
});

/**
 * The active company, always inside the active workspace: the company
 * cookie when it points there, else the workspace's first company the
 * user can open, else null (they have a seat but no company yet).
 */
export const getCurrentOrg = cache(async (): Promise<MembershipWithOrg | null> => {
  const ws = await getCurrentWorkspace();
  if (!ws) return null;
  const inWorkspace = (await getUserMemberships()).filter((m) => m.organization.workspaceId === ws.workspaceId);
  const preferred = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  return inWorkspace.find((m) => m.organizationId === preferred) ?? inWorkspace[0] ?? null;
});

/**
 * Guard for company pages. No company here yet: workspace members land on
 * the workspace home; brand-new users on onboarding.
 */
export async function requireCurrentOrg(): Promise<MembershipWithOrg> {
  await requireUser();
  const current = await getCurrentOrg();
  if (current) return current;
  redirect((await getUserWorkspaces()).length ? "/workspace" : "/onboarding");
}

export { ROLE_RANK, hasRole, type Role } from "@/lib/actor";

/** Guard for routes that require a minimum company role (403 otherwise). */
export async function requireRole(min: Role): Promise<MembershipWithOrg> {
  const current = await requireCurrentOrg();
  if (!hasRole(current.role, min)) {
    const { forbidden } = await import("next/navigation");
    forbidden();
  }
  return current;
}

/** The signed-in human as a company Actor, for calling services. */
export async function requireActor(min: Role = "viewer"): Promise<Actor> {
  const user = await requireUser();
  const current = await requireRole(min);
  return userActor({
    organizationId: current.organizationId,
    userId: user.id,
    role: current.role,
    meta: await getRequestMeta(),
    support: Boolean(current.support),
  });
}

/** Guard for workspace pages: the current workspace and the user's role in it. */
export async function requireWorkspace(min: WorkspaceRole = "member"): Promise<WorkspaceMembership> {
  await requireUser();
  const ws = await getCurrentWorkspace();
  if (!ws) redirect("/onboarding");
  if (!hasWorkspaceRole(ws.role, min)) {
    const { forbidden } = await import("next/navigation");
    forbidden();
  }
  return ws;
}

/** The signed-in human as a WorkspaceActor. */
export async function requireWorkspaceActor(min: WorkspaceRole = "member"): Promise<WorkspaceActor> {
  const user = await requireUser();
  const ws = await requireWorkspace(min);
  return workspaceActor({
    workspaceId: ws.workspaceId,
    userId: user.id,
    role: ws.role,
    meta: await getRequestMeta(),
  });
}
