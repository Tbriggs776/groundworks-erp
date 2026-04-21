import { relations, sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  recurringFrequency,
  recurringStatus,
  timestamps,
} from "./_shared";
import { accounts } from "./accounts";
import { dimensions, dimensionValues } from "./dimensions";
import { organizations, profiles } from "./identity";
import { glJournals, journalTemplates } from "./journals";
import { reasonCodes } from "./journal_meta";

/**
 * RECURRING JOURNALS — template for a JE that should post on a cadence.
 *
 *   frequency + frequency_day / frequency_weekday drive next_run_date
 *     monthly  + frequency_day=15 → post on the 15th each month
 *     weekly   + frequency_weekday=1 → post every Monday
 *     quarterly + frequency_day=1   → post on the 1st of each quarter
 *
 *   next_run_date is the authoritative scheduler cursor. The cron job queries
 *   WHERE status='active' AND next_run_date <= today, generates a JE, then
 *   advances next_run_date by one interval.
 *
 *   end_date is inclusive — on the first run AFTER end_date, the recurring
 *   transitions to status='ended' and stops.
 */
export const recurringJournals = pgTable(
  "recurring_journals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    journalTemplateId: uuid("journal_template_id")
      .notNull()
      .references(() => journalTemplates.id, { onDelete: "restrict" }),
    reasonCodeId: uuid("reason_code_id").references(() => reasonCodes.id, {
      onDelete: "set null",
    }),
    journalDescription: text("journal_description").notNull(),

    frequency: recurringFrequency("frequency").notNull(),
    frequencyDay: integer("frequency_day"), // 1..31 for monthly/quarterly/etc.
    frequencyWeekday: integer("frequency_weekday"), // 0..6 for weekly/biweekly

    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextRunDate: date("next_run_date").notNull(),
    lastRunDate: date("last_run_date"),
    lastRunJournalId: uuid("last_run_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),

    currency: text("currency").notNull().default("USD"),

    status: recurringStatus("status").notNull().default("active"),
    createdBy: uuid("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("recurring_journals_org_code_key").on(t.organizationId, t.code),
    index("recurring_journals_due_idx").on(
      t.organizationId,
      t.status,
      t.nextRunDate
    ),
  ]
);

/**
 * RECURRING JOURNAL LINES — template rows. Structurally similar to gl_lines
 * but holds fixed amounts (no running totals). Forward refs to subledger
 * FKs kept plain UUID until modules land.
 */
export const recurringJournalLines = pgTable(
  "recurring_journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recurringJournalId: uuid("recurring_journal_id")
      .notNull()
      .references(() => recurringJournals.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    debit: numeric("debit", { precision: 20, scale: 4 }).notNull().default("0"),
    credit: numeric("credit", { precision: 20, scale: 4 }).notNull().default("0"),

    memo: text("memo"),
    reference: text("reference"),

    // Forward refs
    jobId: uuid("job_id"),
    costCodeId: uuid("cost_code_id"),
    customerId: uuid("customer_id"),
    vendorId: uuid("vendor_id"),
    employeeId: uuid("employee_id"),
    fixedAssetId: uuid("fixed_asset_id"),
    bankAccountId: uuid("bank_account_id"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("recurring_lines_parent_line_key").on(
      t.recurringJournalId,
      t.lineNumber
    ),
    check(
      "recurring_lines_debit_xor_credit",
      sql`(${t.debit} > 0 AND ${t.credit} = 0) OR (${t.credit} > 0 AND ${t.debit} = 0)`
    ),
  ]
);

/**
 * RECURRING LINE DIMENSIONS — dimension values attached to each template
 * line. Copied to gl_line_dimensions when the recurring runs.
 */
export const recurringLineDimensions = pgTable(
  "recurring_line_dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lineId: uuid("line_id")
      .notNull()
      .references(() => recurringJournalLines.id, { onDelete: "cascade" }),
    dimensionId: uuid("dimension_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "restrict" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => dimensionValues.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("recurring_line_dims_line_dim_key").on(t.lineId, t.dimensionId),
  ]
);

export const recurringJournalsRelations = relations(
  recurringJournals,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [recurringJournals.organizationId],
      references: [organizations.id],
    }),
    template: one(journalTemplates, {
      fields: [recurringJournals.journalTemplateId],
      references: [journalTemplates.id],
    }),
    lastRunJournal: one(glJournals, {
      fields: [recurringJournals.lastRunJournalId],
      references: [glJournals.id],
    }),
    lines: many(recurringJournalLines),
  })
);

export const recurringJournalLinesRelations = relations(
  recurringJournalLines,
  ({ one, many }) => ({
    parent: one(recurringJournals, {
      fields: [recurringJournalLines.recurringJournalId],
      references: [recurringJournals.id],
    }),
    account: one(accounts, {
      fields: [recurringJournalLines.accountId],
      references: [accounts.id],
    }),
    dimensionValues: many(recurringLineDimensions),
  })
);

// Give glJournals a back-reference to its recurring parent (useful when
// inspecting posted history: "which recurring generated this?").
// Note: gl_journals.recurring_journal_id is a plain UUID forward-ref
// column on the gl_journals table. We can now wire the FK here since the
// target exists in this file's import graph.
// (The column itself was defined in Chunk B; we just add a relation hint.)
export const glJournalsRecurringRelation = relations(glJournals, ({ one }) => ({
  recurring: one(recurringJournals, {
    fields: [glJournals.recurringJournalId],
    references: [recurringJournals.id],
  }),
}));

export type RecurringJournal = typeof recurringJournals.$inferSelect;
export type NewRecurringJournal = typeof recurringJournals.$inferInsert;
export type RecurringJournalLine = typeof recurringJournalLines.$inferSelect;
export type NewRecurringJournalLine = typeof recurringJournalLines.$inferInsert;
export type RecurringLineDimension = typeof recurringLineDimensions.$inferSelect;
export type NewRecurringLineDimension =
  typeof recurringLineDimensions.$inferInsert;
