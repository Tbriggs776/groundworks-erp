import { date, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { accounts } from "./accounts";
import { organizations, profiles } from "./identity";

/**
 * BANK FEEDS. A connection is one bank login through Plaid (an "item"),
 * holding its sealed access token and the sync cursor; it brings one or
 * more of the bank's accounts, each linked to a bank or card account in
 * the chart. Synced transactions land in For review as statement lines
 * (format `feed`), so rules, matching, and review work the same as for an
 * imported statement.
 */

export const bankFeedStatus = pgEnum("bank_feed_status", ["active", "login_required", "disconnected"]);

export const bankFeedConnections = pgTable(
  "bank_feed_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("plaid"),
    /** Plaid's item id: webhooks name it. */
    itemId: text("item_id").notNull(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    /** Sealed with APP_ENCRYPTION_KEY (src/lib/security/crypto.ts); null once disconnected. */
    accessToken: text("access_token"),
    /** Where the next sync picks up (Plaid's transactions/sync cursor). */
    cursor: text("cursor"),
    status: bankFeedStatus("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    connectedBy: uuid("connected_by").references(() => profiles.id, { onDelete: "set null" }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("bank_feed_connections_item_key").on(t.itemId), index("bank_feed_connections_org_idx").on(t.organizationId)]
);

export const bankFeedAccounts = pgTable(
  "bank_feed_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => bankFeedConnections.id, { onDelete: "cascade" }),
    /** Plaid's account id. */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    mask: text("mask"),
    /** depository, credit, loan, … and checking, savings, credit card, … */
    type: text("type"),
    subtype: text("subtype"),
    /** The bank or card account in the chart its transactions go to; null = not imported. */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** Transactions dated before this don't come in (set when linked: after the last reconciliation or statement). */
    startDate: date("start_date"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bank_feed_accounts_key").on(t.connectionId, t.externalId),
    index("bank_feed_accounts_account_idx").on(t.organizationId, t.accountId),
  ]
);

export type BankFeedConnection = typeof bankFeedConnections.$inferSelect;
export type BankFeedAccount = typeof bankFeedAccounts.$inferSelect;
