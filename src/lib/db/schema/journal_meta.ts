import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { organizations } from "./identity";

/**
 * SOURCE CODES — origin classification for a journal (GP-style). Seeded on
 * org creation with: GJ, SJ, PJ, CR, CD, PY, YE, ADJ, REV, IC. Admins may
 * add their own but `isSystem=true` rows block deletion.
 */
export const sourceCodes = pgTable(
  "source_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    description: text("description").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("source_codes_org_code_key").on(t.organizationId, t.code)]
);

/**
 * REASON CODES — optional tag on a journal explaining why it was made.
 * Useful audit context, especially on hard-close override posts and on
 * adjusting entries.
 */
export const reasonCodes = pgTable(
  "reason_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    description: text("description").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("reason_codes_org_code_key").on(t.organizationId, t.code)]
);

/**
 * NUMBER SERIES — generators for auto-numbered documents. One series per
 * document type (journal entries, POs, invoices, etc.). `lastUsedNumber`
 * is the safe high-water mark; concurrent posts increment atomically.
 *
 * Next number formula: `${prefix}${lpad(lastUsedNumber + increment, width)}`.
 */
export const numberSeries = pgTable(
  "number_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(), // e.g. 'GJ', 'JE', 'PO', 'INV'
    description: text("description").notNull(),
    prefix: text("prefix").notNull().default(""),
    startNumber: integer("start_number").notNull().default(1),
    increment: integer("increment").notNull().default(1),
    width: integer("width").notNull().default(6),
    lastUsedNumber: integer("last_used_number").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("number_series_org_code_key").on(t.organizationId, t.code)]
);

export const sourceCodesRelations = relations(sourceCodes, ({ one }) => ({
  organization: one(organizations, {
    fields: [sourceCodes.organizationId],
    references: [organizations.id],
  }),
}));

export const reasonCodesRelations = relations(reasonCodes, ({ one }) => ({
  organization: one(organizations, {
    fields: [reasonCodes.organizationId],
    references: [organizations.id],
  }),
}));

export const numberSeriesRelations = relations(numberSeries, ({ one }) => ({
  organization: one(organizations, {
    fields: [numberSeries.organizationId],
    references: [organizations.id],
  }),
}));

export type SourceCode = typeof sourceCodes.$inferSelect;
export type NewSourceCode = typeof sourceCodes.$inferInsert;
export type ReasonCode = typeof reasonCodes.$inferSelect;
export type NewReasonCode = typeof reasonCodes.$inferInsert;
export type NumberSeries = typeof numberSeries.$inferSelect;
export type NewNumberSeries = typeof numberSeries.$inferInsert;
