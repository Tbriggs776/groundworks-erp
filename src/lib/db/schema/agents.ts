import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membershipRole, timestamps } from "./_shared";
import { organizations, profiles } from "./identity";

/**
 * AGENTS + API KEYS — non-human principals and the credentials that act
 * for them (or for a human, as a personal key).
 *
 * The model, in one breath: an AGENT is a named, org-scoped member that
 * happens not to be a person. It carries a role (same ladder as humans) and
 * an AUTONOMY level that decides how far it can go without a human:
 *
 *   read   — look, never touch
 *   draft  — create and edit drafts; a human posts them from the review queue
 *   post   — may post to the ledger itself, up to `maxPostAmount` per
 *            document (null = no ceiling). Anything above the ceiling is
 *            left as a draft for review.
 *
 * Agents never get the `admin` scope: an agent can't mint keys, add
 * members, or change its own autonomy.
 *
 * API KEYS authenticate either an agent (agent_id) or a human acting
 * through tooling (user_id, a personal key). Only the SHA-256 of the
 * secret is stored; `prefix` is the first 12 characters for display and
 * support. Keys are revoked, never deleted, so audit rows that point at
 * them stay meaningful.
 */

export const agentAutonomy = pgEnum("agent_autonomy", ["read", "draft", "post"]);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    description: text("description"),

    role: membershipRole("role").notNull().default("bookkeeper"),
    autonomy: agentAutonomy("autonomy").notNull().default("draft"),
    /** Per-document posting ceiling in base currency; null = unlimited. */
    maxPostAmount: numeric("max_post_amount", { precision: 20, scale: 4 }),

    createdBy: uuid("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("agents_org_name_key").on(t.organizationId, t.name),
    // Agents may not hold owner/admin — those roles manage people and keys.
    check(
      "agents_role_not_admin",
      sql`${t.role} NOT IN ('owner', 'admin')`
    ),
  ]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    /** Exactly one of agent_id / user_id is set (CHECK below). */
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => profiles.id, {
      onDelete: "cascade",
    }),

    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    /** Subset of read / write / post / admin. Effective scopes are this set
     *  intersected with what the principal's role + autonomy allow. */
    scopes: text("scopes").array().notNull().default(sql`ARRAY['read']::text[]`),

    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("api_keys_secret_hash_key").on(t.secretHash),
    index("api_keys_org_idx").on(t.organizationId),
    index("api_keys_agent_idx").on(t.agentId),
    check(
      "api_keys_one_principal",
      sql`(${t.agentId} IS NULL) <> (${t.userId} IS NULL)`
    ),
  ]
);

/**
 * IDEMPOTENCY KEYS — agents retry. A mutating API / MCP call that carries
 * an idempotency key is executed at most once per (org, key); replays get
 * the stored response. `requestHash` catches a key reused with a different
 * payload. Rows older than 24h can be pruned.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idempotency_keys_org_key").on(t.organizationId, t.key),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ]
);

export const agentsRelations = relations(agents, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [agents.organizationId],
    references: [organizations.id],
  }),
  creator: one(profiles, {
    fields: [agents.createdBy],
    references: [profiles.id],
  }),
  apiKeys: many(apiKeys),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
  agent: one(agents, {
    fields: [apiKeys.agentId],
    references: [agents.id],
  }),
  user: one(profiles, {
    fields: [apiKeys.userId],
    references: [profiles.id],
  }),
}));

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
