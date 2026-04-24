import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvalThresholds, type ApprovalThreshold } from "@/lib/db/schema";
import { ROLE_RANK, type Role } from "@/lib/auth";
import { money } from "@/lib/money";

/**
 * Approval routing for AP bills. Given a bill amount, find the matching
 * threshold tier and the minimum role that can approve it. If no active
 * threshold covers the amount, default to 'admin' (safe fallback — no
 * silent bypass).
 *
 * Tier matching rules:
 *   - `min_amount` INCLUSIVE, `max_amount` EXCLUSIVE.
 *   - `max_amount = NULL` is treated as +∞ (top tier, unbounded).
 *   - Among matching tiers, pick the one with the HIGHEST `min_amount`
 *     (most specific). Sort order is a tiebreaker for same-min tiers.
 *   - Only `is_active = true` rows participate.
 */
export type ApprovalRouting = {
  threshold: ApprovalThreshold | null;
  requiredRole: Role;
  /** True if the threshold set was empty/inactive — fallback is in effect. */
  fallback: boolean;
};

export async function resolveApprovalRouting(
  organizationId: string,
  scope: "ap_bill",
  amount: string | number
): Promise<ApprovalRouting> {
  const amt = money(amount);

  const rows = await db
    .select()
    .from(approvalThresholds)
    .where(
      and(
        eq(approvalThresholds.organizationId, organizationId),
        eq(approvalThresholds.scope, scope),
        eq(approvalThresholds.isActive, true)
      )
    )
    .orderBy(asc(approvalThresholds.sortOrder));

  // Find candidates: min <= amount AND (max IS NULL OR amount < max)
  const candidates = rows.filter((t) => {
    const min = money(t.minAmount);
    if (amt.lt(min)) return false;
    if (t.maxAmount === null) return true;
    return amt.lt(money(t.maxAmount));
  });

  if (candidates.length === 0) {
    return { threshold: null, requiredRole: "admin", fallback: true };
  }

  // Pick the candidate with the highest minAmount (most specific).
  candidates.sort((a, b) => {
    const diff = money(b.minAmount).minus(money(a.minAmount));
    if (diff.gt(0)) return 1;
    if (diff.lt(0)) return -1;
    return a.sortOrder - b.sortOrder;
  });
  const chosen = candidates[0];

  return {
    threshold: chosen,
    requiredRole: chosen.requiredRole,
    fallback: false,
  };
}

/**
 * Does the given user role meet or exceed the required role for approval?
 * Uses ROLE_RANK (owner=5, admin=4, ..., viewer=0).
 */
export function canApproveAtRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[requiredRole];
}

// unused-import guard for some tooling paths
void sql;
