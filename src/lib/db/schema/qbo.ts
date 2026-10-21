import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { organizations, profiles } from "./identity";

/**
 * QUICKBOOKS ONLINE IMPORT. A company made from a QuickBooks import keeps
 * its connection (OAuth tokens, sealed: never readable through the API or
 * RLS), the import run's progress, and a map from each QuickBooks record
 * to the Groundworks row it became, so a run can stop and resume without
 * creating anything twice.
 */

export const qboEnvironment = pgEnum("qbo_environment", ["sandbox", "production"]);
export const qboImportStatus = pgEnum("qbo_import_status", ["running", "failed", "done"]);

export const qboConnections = pgTable(
  "qbo_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    realmId: text("realm_id").notNull(),
    environment: qboEnvironment("environment").notNull(),
    companyName: text("company_name"),
    /** Sealed with APP_ENCRYPTION_KEY (src/lib/security/crypto.ts). */
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    connectedBy: uuid("connected_by").references(() => profiles.id, { onDelete: "set null" }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("qbo_connections_org_key").on(t.organizationId)]
);

export type QboCursor = { step: string; position: number };
export type QboCounts = Record<string, { imported: number; skipped: number }>;

export const qboImports = pgTable(
  "qbo_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: qboImportStatus("status").notNull().default("running"),
    /** Where the next batch picks up: a step and how far into it. */
    cursor: jsonb("cursor").$type<QboCursor>().notNull(),
    counts: jsonb("counts").$type<QboCounts>().notNull().default({}),
    /** Things that came across differently, for the person to review. */
    notes: jsonb("notes").$type<string[]>().notNull().default([]),
    lastError: text("last_error"),
    batches: integer("batches").notNull().default(0),
    startedBy: uuid("started_by").references(() => profiles.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("qbo_imports_org_idx").on(t.organizationId)]
);

export const qboIdMap = pgTable(
  "qbo_id_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** QuickBooks entity name: Account, Customer, Vendor, Item, Class, Department, Term, JournalEntry, … */
    entity: text("entity").notNull(),
    qboId: text("qbo_id").notNull(),
    /** The Groundworks row it became (a term maps to no row: localId null, `value` holds its days). */
    localId: uuid("local_id"),
    value: text("value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("qbo_id_map_key").on(t.organizationId, t.entity, t.qboId)]
);

export type QboConnection = typeof qboConnections.$inferSelect;
export type QboImport = typeof qboImports.$inferSelect;
