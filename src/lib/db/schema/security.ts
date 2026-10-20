import {
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./agents";
import { profiles, workspaces } from "./identity";

/**
 * SECURITY — the records behind session control and access reviews.
 *
 * USER SESSIONS mirror Supabase Auth sessions (same id as the JWT's
 * `session_id` claim). Every authenticated request checks its row, so a
 * revoked or timed-out session stops working on the next click, not when
 * the access token expires. Server-only: no RLS policy.
 */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    /** When the person proved who they are (first factor). */
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Authenticator assurance level last seen: aal1 or aal2 (MFA). */
    aal: text("aal").notNull().default("aal1"),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** signed_out | idle_timeout | max_age | revoked_by_user */
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_sessions_user_idx").on(t.userId, t.lastSeenAt)]
);

/**
 * ACCESS REVIEWS — a workspace admin's sign-off that everyone's access is
 * still right. `snapshot` freezes who had what at the moment of review
 * (people, company roles, agents, keys), which is the evidence an auditor
 * asks for. Append-only.
 */
export const accessReviews = pgTable(
  "access_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    reviewedBy: uuid("reviewed_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    snapshot: jsonb("snapshot").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("access_reviews_ws_idx").on(t.workspaceId, t.completedAt)]
);

/**
 * API RATE LIMITS — one counter per key per minute. Shared by every server
 * instance, so the limit holds on serverless too. Old windows are pruned
 * by the daily cron. Server-only: no RLS policy.
 */
export const apiRateLimits = pgTable(
  "api_rate_limits",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.windowStart] })]
);

/**
 * SUPPORT ACCESS — a workspace owner lets Groundworks support look inside
 * for a limited time (read-only). Off unless a live grant exists: nobody at
 * Groundworks can open a workspace otherwise. Revoking or expiry ends it on
 * the next click. Members can read their workspace's grants (RLS).
 */
export const supportAccessGrants = pgTable(
  "support_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => profiles.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_access_grants_ws_idx").on(t.workspaceId, t.expiresAt)]
);

export type UserSession = typeof userSessions.$inferSelect;
export type AccessReview = typeof accessReviews.$inferSelect;
export type SupportAccessGrant = typeof supportAccessGrants.$inferSelect;
