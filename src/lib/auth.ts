import { cache } from "react";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memberships, organizations } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side auth helpers. All of these run in Server Components / Server
 * Actions. Client code should never call these directly.
 *
 * React's `cache` memoizes these within a single request so we don't hammer
 * the DB when multiple components/layouts ask for the same user/org.
 */

export type SessionUser = {
  id: string;
  email: string;
};

/**
 * Returns the Supabase-authenticated user. Throws if called outside an auth
 * context — use `requireUser()` for route gating.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return null;
  return { id: user.id, email: user.email };
});

/**
 * Route guard: returns the current user, redirecting to /auth/login if anon.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/auth/login");
  return user;
}

export type MembershipWithOrg = {
  membershipId: string;
  organizationId: string;
  role: "owner" | "admin" | "accountant" | "pm" | "foreman" | "viewer";
  organization: typeof organizations.$inferSelect;
};

/**
 * All active memberships the current user holds, joined to the organization
 * row. Returns an empty array for new users who haven't completed onboarding.
 */
export const getUserMemberships = cache(
  async (): Promise<MembershipWithOrg[]> => {
    const user = await getUser();
    if (!user) return [];

    const rows = await db
      .select({
        membershipId: memberships.id,
        organizationId: memberships.organizationId,
        role: memberships.role,
        organization: organizations,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.isActive, true),
          isNull(memberships.deletedAt),
          isNull(organizations.deletedAt)
        )
      );

    return rows;
  }
);

/**
 * Returns the currently active organization for the user.
 *
 * For v1 we pick "first active membership, ordered by created_at ASC". When
 * we add a multi-org switcher, this will read the active-org selection from
 * a cookie or URL segment.
 */
export const getCurrentOrg = cache(
  async (): Promise<MembershipWithOrg | null> => {
    const all = await getUserMemberships();
    if (all.length === 0) return null;
    // Stable pick; assumes the DB returns rows in insert order for equal ranks.
    return all[0];
  }
);

/**
 * Route guard for authed routes that REQUIRE an active membership. If the
 * user has none, redirect to onboarding. If they have one, return it.
 */
export async function requireCurrentOrg(): Promise<MembershipWithOrg> {
  await requireUser();
  const current = await getCurrentOrg();
  if (!current) redirect("/onboarding");
  return current;
}

/**
 * Role hierarchy for authorization checks. Higher rank = more privilege.
 * Roles are listed in the membership_role enum; keep these in sync.
 */
export const ROLE_RANK = {
  owner: 5,
  admin: 4,
  accountant: 3,
  pm: 2,
  foreman: 1,
  viewer: 0,
} as const satisfies Record<MembershipWithOrg["role"], number>;

export type Role = keyof typeof ROLE_RANK;

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Route guard for routes that require a minimum role. Redirects to login /
 * onboarding as needed; returns 403 via Next's `forbidden()` if the role is
 * below the minimum. Use sparingly at route boundaries; fine-grained checks
 * should happen inside business logic too.
 */
export async function requireRole(min: Role): Promise<MembershipWithOrg> {
  const current = await requireCurrentOrg();
  if (!hasRole(current.role, min)) {
    // Next 16's forbidden() renders the nearest forbidden.tsx boundary
    // (or a default 403 page if none is defined).
    const { forbidden } = await import("next/navigation");
    forbidden();
  }
  return current;
}
