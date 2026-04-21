import { relations } from "drizzle-orm";
import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fiscalYearStatus, periodStatus, timestamps } from "./_shared";
import { organizations, profiles } from "./identity";

/**
 * FISCAL YEARS — an organization's fiscal calendar. One row per org per year.
 * `startDate` and `endDate` bound the year; periods below divide it up.
 * Supports 12-month, fiscal, and 13-period (4-4-5) layouts.
 */
export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    yearLabel: text("year_label").notNull(), // e.g. "FY2026"
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: fiscalYearStatus("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("fiscal_years_org_label_key").on(t.organizationId, t.yearLabel),
    index("fiscal_years_org_start_idx").on(t.organizationId, t.startDate),
  ]
);

/**
 * FISCAL PERIODS — monthly (or 4-4-5) buckets within a fiscal year.
 * `status`:
 *   - open        — any authorized user can post
 *   - soft_closed — only source=adjusting|reversing accepted
 *   - hard_closed — no posting without the org hard-close override password
 */
export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    periodNo: integer("period_no").notNull(),
    periodCode: text("period_code").notNull(), // e.g. "FY2026-03"
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: periodStatus("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("fiscal_periods_org_code_key").on(
      t.organizationId,
      t.periodCode
    ),
    index("fiscal_periods_org_dates_idx").on(
      t.organizationId,
      t.startDate,
      t.endDate
    ),
    index("fiscal_periods_year_idx").on(t.fiscalYearId, t.periodNo),
  ]
);

/**
 * POSTING DATE RESTRICTIONS — per-user window that bounds which journal_date
 * values they may post. Example: "Accountant Jane can only post to dates
 * in the current + previous month." Optional; no row = unrestricted (subject
 * still to period status).
 */
export const postingDateRestrictions = pgTable(
  "posting_date_restrictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    allowPostFrom: date("allow_post_from"),
    allowPostTo: date("allow_post_to"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("posting_date_restrictions_key").on(
      t.organizationId,
      t.userId
    ),
  ]
);

export const fiscalYearsRelations = relations(fiscalYears, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [fiscalYears.organizationId],
    references: [organizations.id],
  }),
  periods: many(fiscalPeriods),
}));

export const fiscalPeriodsRelations = relations(fiscalPeriods, ({ one }) => ({
  organization: one(organizations, {
    fields: [fiscalPeriods.organizationId],
    references: [organizations.id],
  }),
  fiscalYear: one(fiscalYears, {
    fields: [fiscalPeriods.fiscalYearId],
    references: [fiscalYears.id],
  }),
}));

export type FiscalYear = typeof fiscalYears.$inferSelect;
export type NewFiscalYear = typeof fiscalYears.$inferInsert;
export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type NewFiscalPeriod = typeof fiscalPeriods.$inferInsert;
export type PostingDateRestriction =
  typeof postingDateRestrictions.$inferSelect;
