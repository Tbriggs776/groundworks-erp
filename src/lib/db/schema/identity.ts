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
import { membershipRole, timestamps } from "./_shared";

/**
 * ORGANIZATION — the tenant root. Every domain row in the system carries
 * `organization_id`. Row-level security policies (to be applied in a migration)
 * will enforce tenant isolation at the DB layer as a safety net.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  (t) => [uniqueIndex("organizations_slug_key").on(t.slug)]
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
 * INVITATION — pending invite; consumed on accept. Tokens are opaque random
 * strings; `expiresAt` should be <= 7 days. One active invite per (org, email).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: membershipRole("role").notNull().default("viewer"),
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
    index("invitations_org_email_idx").on(t.organizationId, t.email),
  ]
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  invitations: many(invitations),
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

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
