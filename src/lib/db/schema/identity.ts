import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membershipRole, timestamps, workspaceRole } from "./_shared";

/**
 * WORKSPACE — the account a business signs up for, above its companies.
 * One sign-in reaches every company in every workspace the person belongs
 * to. The workspace owns the people directory, invitations, and the
 * security policy (MFA, session timeouts, key lifetime) that applies to
 * everyone in it.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),

    // Security policy. A person in several workspaces gets the strictest.
    /** Every member must sign in with a second factor (TOTP). */
    requireMfa: boolean("require_mfa").notNull().default(false),
    /** Sign out after this many minutes without activity. */
    sessionIdleMinutes: integer("session_idle_minutes").notNull().default(60),
    /** Sign in again after this many hours, active or not. */
    sessionMaxHours: integer("session_max_hours").notNull().default(24),
    /** Longest an API key may live; null = no limit. */
    apiKeyMaxDays: integer("api_key_max_days"),
    /** Invitations only to these email domains; null/empty = any. */
    allowedEmailDomains: text("allowed_email_domains").array(),

    createdBy: uuid("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [uniqueIndex("workspaces_slug_key").on(t.slug)]
);

/**
 * WORKSPACE MEMBER — a person in a workspace. Company access is separate:
 * one `memberships` row per company, each with its own role.
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull().default("member"),
    isActive: boolean("is_active").notNull().default(true),
    invitedBy: uuid("invited_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workspace_members_ws_user_key").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
  ]
);

/**
 * ORGANIZATION — a company: the tenant root for the books. Every domain row
 * carries `organization_id`, and RLS enforces tenant isolation as a safety
 * net. Each company belongs to exactly one workspace.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    baseCurrency: text("base_currency").notNull().default("USD"),
    fiscalYearStartMonth: integer("fiscal_year_start_month")
      .notNull()
      .default(1),

    // GL behavior settings
    /**
     * Hard-close override password. Hashed with argon2. Null = no override
     * permitted (admins must set one for hard-close overrides to be possible).
     * See src/lib/auth/password.ts for hashing helpers.
     */
    hardCloseOverridePasswordHash: text("hard_close_override_password_hash"),
    requireReasonForOverride: boolean("require_reason_for_override")
      .notNull()
      .default(true),

    settings: jsonb("settings").notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organizations_slug_key").on(t.slug),
    index("organizations_workspace_idx").on(t.workspaceId),
  ]
);

/**
 * PROFILE — app-side user record. The `id` matches `auth.users.id` in the
 * Supabase `auth` schema. Created by a trigger on signup (migration adds it).
 */
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  fullName: text("full_name"),
  avatarUrl: text("avatar_url"),
  ...timestamps,
});

/**
 * MEMBERSHIP — joins a profile to an organization with a role. One row per
 * (user, org) pair. `isActive = false` soft-deactivates without losing history.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull().default("viewer"),
    isActive: boolean("is_active").notNull().default(true),
    invitedBy: uuid("invited_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memberships_org_user_key").on(t.organizationId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ]
);

/**
 * INVITATION — a pending invite to a workspace, consumed on accept. It
 * carries the workspace role plus the companies to open up, each with a
 * role. Only the SHA-256 of the token is stored. One live invite per
 * (workspace, email).
 */
export type InvitationGrant = {
  organizationId: string;
  role: (typeof membershipRole.enumValues)[number];
};

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    workspaceRole: workspaceRole("workspace_role").notNull().default("member"),
    grants: jsonb("grants").$type<InvitationGrant[]>().notNull().default([]),
    token: text("token").notNull(),
    invitedBy: uuid("invited_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invitations_token_key").on(t.token),
    index("invitations_ws_email_idx").on(t.workspaceId, t.email),
  ]
);

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  organizations: many(organizations),
  members: many(workspaceMembers),
  invitations: many(invitations),
}));

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [organizations.workspaceId],
    references: [workspaces.id],
  }),
  memberships: many(memberships),
}));

export const profilesRelations = relations(profiles, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  user: one(profiles, {
    fields: [memberships.userId],
    references: [profiles.id],
  }),
  inviter: one(profiles, {
    fields: [memberships.invitedBy],
    references: [profiles.id],
  }),
}));

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
