import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  balAccountType,
  batchStatus,
  journalSource,
  journalStatus,
  timestamps,
} from "./_shared";
import { accounts } from "./accounts";
import { dimensions, dimensionValues } from "./dimensions";
import { organizations, profiles } from "./identity";
import { fiscalPeriods } from "./periods";
import { numberSeries, reasonCodes, sourceCodes } from "./journal_meta";

/**
 * JOURNAL TEMPLATES — reusable setups that pre-fill source/number series/
 * default accounts/dimension rules on new journals. A template isn't required
 * to post a journal; it just saves keystrokes.
 */
export const journalTemplates = pgTable(
  "journal_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sourceCodeId: uuid("source_code_id")
      .notNull()
      .references(() => sourceCodes.id, { onDelete: "restrict" }),
    numberSeriesId: uuid("number_series_id")
      .notNull()
      .references(() => numberSeries.id, { onDelete: "restrict" }),
    defaultAccountId: uuid("default_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    defaultBalAccountType: balAccountType("default_bal_account_type")
      .notNull()
      .default("gl"),
    forcePostingDate: boolean("force_posting_date").notNull().default(false),
    reasonCodeMandatory: boolean("reason_code_mandatory")
      .notNull()
      .default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("journal_templates_org_code_key").on(t.organizationId, t.code),
  ]
);

/**
 * JOURNAL BATCHES — optional staging for journals that will post together.
 * If omitted (batch_id IS NULL on a journal), that journal is posted solo.
 */
export const journalBatches = pgTable(
  "journal_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    journalTemplateId: uuid("journal_template_id").references(
      () => journalTemplates.id,
      { onDelete: "set null" }
    ),
    code: text("code").notNull(),
    description: text("description"),
    postingDate: date("posting_date"),
    reasonCodeId: uuid("reason_code_id").references(() => reasonCodes.id, {
      onDelete: "set null",
    }),
    sourceCodeId: uuid("source_code_id").references(() => sourceCodes.id, {
      onDelete: "set null",
    }),
    status: batchStatus("status").notNull().default("open"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("journal_batches_org_code_key").on(t.organizationId, t.code),
    index("journal_batches_org_status_idx").on(t.organizationId, t.status),
  ]
);

/**
 * GL JOURNALS — the header of one balanced entry. Posted journals are
 * IMMUTABLE; enforced at DB level by a trigger (see migration 0005). App code
 * adds further discipline — posted journals never appear in UPDATE paths.
 *
 * Reversal linkage:
 *   reverses_journal_id      — set on a reversing journal, points to the
 *                              original that it undoes
 *   reversed_by_journal_id   — set on the ORIGINAL when a reversal is posted,
 *                              points to the reversing journal
 *   auto_reverse_date        — for accruals: posting function schedules a
 *                              reversal on this date (job in Chunk C)
 *
 * Hard-close override fields:
 *   override_hard_close / override_reason / override_approved_by
 *   populated only when posting to a hard_closed period with a valid
 *   org-level override password.
 */
export const glJournals = pgTable(
  "gl_journals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => journalBatches.id, {
      onDelete: "set null",
    }),
    journalTemplateId: uuid("journal_template_id").references(
      () => journalTemplates.id,
      { onDelete: "set null" }
    ),

    journalNumber: text("journal_number").notNull(),
    documentNo: text("document_no"),
    journalDate: date("journal_date").notNull(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "restrict" }),
    sourceCodeId: uuid("source_code_id")
      .notNull()
      .references(() => sourceCodes.id, { onDelete: "restrict" }),
    source: journalSource("source").notNull(),
    sourceDocumentType: text("source_document_type"),
    sourceDocumentId: uuid("source_document_id"),
    reasonCodeId: uuid("reason_code_id").references(() => reasonCodes.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),

    status: journalStatus("status").notNull().default("draft"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    reversesJournalId: uuid("reverses_journal_id").references(
      (): AnyPgColumn => glJournals.id,
      { onDelete: "set null" }
    ),
    reversedByJournalId: uuid("reversed_by_journal_id").references(
      (): AnyPgColumn => glJournals.id,
      { onDelete: "set null" }
    ),
    autoReverseDate: date("auto_reverse_date"),

    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", {
      precision: 20,
      scale: 10,
    })
      .notNull()
      .default("1"),

    // Hard-close override trail
    overrideHardClose: boolean("override_hard_close").notNull().default(false),
    overrideReason: text("override_reason"),
    overrideApprovedBy: uuid("override_approved_by").references(
      () => profiles.id,
      { onDelete: "set null" }
    ),

    // Forward ref — recurring_journals table lands in Chunk C; kept nullable.
    recurringJournalId: uuid("recurring_journal_id"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("gl_journals_org_number_key").on(
      t.organizationId,
      t.journalNumber
    ),
    index("gl_journals_org_period_status_idx").on(
      t.organizationId,
      t.periodId,
      t.status
    ),
    index("gl_journals_org_date_idx").on(t.organizationId, t.journalDate),
    index("gl_journals_org_source_idx").on(t.organizationId, t.source),
    index("gl_journals_reverses_idx").on(t.reversesJournalId),
  ]
);

/**
 * GL LINES — individual debit OR credit. `debit_local` / `credit_local` hold
 * the amount translated to the org's base currency at the journal's
 * exchange_rate; `debit` / `credit` are in the journal's currency.
 *
 * CHECK: exactly one of (debit, credit) is > 0; the other is 0.
 *        debit_local / credit_local mirror the same side.
 *
 * Denormalized `organization_id` keeps report queries fast — no JOIN to
 * gl_journals required. Kept in sync by the posting function.
 */
export const glLines = pgTable(
  "gl_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => glJournals.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),

    debit: numeric("debit", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    credit: numeric("credit", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    debitLocal: numeric("debit_local", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    creditLocal: numeric("credit_local", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),

    memo: text("memo"),
    reference: text("reference"),

    // Forward refs — these tables land with Projects / AP / AR / etc.
    // Plain UUID columns (no FK constraint) until those modules ship.
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
    index("gl_lines_journal_idx").on(t.journalId, t.lineNumber),
    index("gl_lines_org_account_idx").on(t.organizationId, t.accountId),
    uniqueIndex("gl_lines_journal_line_key").on(t.journalId, t.lineNumber),
    // Debit XOR credit — one side must be > 0, the other must be 0.
    check(
      "gl_lines_debit_xor_credit",
      sql`(${t.debit} > 0 AND ${t.credit} = 0) OR (${t.credit} > 0 AND ${t.debit} = 0)`
    ),
    // Same side in local currency.
    check(
      "gl_lines_local_matches_side",
      sql`((${t.debit} > 0 AND ${t.debitLocal} > 0 AND ${t.creditLocal} = 0) OR (${t.credit} > 0 AND ${t.creditLocal} > 0 AND ${t.debitLocal} = 0))`
    ),
  ]
);

/**
 * GL LINE DIMENSIONS — dimension × value for each line. EAV model for
 * flexibility. A line may have zero-to-many dimensions, but at most one
 * value per dimension (enforced by unique index).
 */
export const glLineDimensions = pgTable(
  "gl_line_dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lineId: uuid("line_id")
      .notNull()
      .references(() => glLines.id, { onDelete: "cascade" }),
    dimensionId: uuid("dimension_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "restrict" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => dimensionValues.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("gl_line_dimensions_line_dim_key").on(
      t.lineId,
      t.dimensionId
    ),
    index("gl_line_dimensions_value_idx").on(
      t.organizationId,
      t.dimensionId,
      t.valueId
    ),
  ]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const journalTemplatesRelations = relations(
  journalTemplates,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [journalTemplates.organizationId],
      references: [organizations.id],
    }),
    sourceCode: one(sourceCodes, {
      fields: [journalTemplates.sourceCodeId],
      references: [sourceCodes.id],
    }),
    numberSeries: one(numberSeries, {
      fields: [journalTemplates.numberSeriesId],
      references: [numberSeries.id],
    }),
    defaultAccount: one(accounts, {
      fields: [journalTemplates.defaultAccountId],
      references: [accounts.id],
    }),
  })
);

export const journalBatchesRelations = relations(
  journalBatches,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [journalBatches.organizationId],
      references: [organizations.id],
    }),
    template: one(journalTemplates, {
      fields: [journalBatches.journalTemplateId],
      references: [journalTemplates.id],
    }),
    journals: many(glJournals),
  })
);

export const glJournalsRelations = relations(glJournals, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [glJournals.organizationId],
    references: [organizations.id],
  }),
  batch: one(journalBatches, {
    fields: [glJournals.batchId],
    references: [journalBatches.id],
  }),
  template: one(journalTemplates, {
    fields: [glJournals.journalTemplateId],
    references: [journalTemplates.id],
  }),
  period: one(fiscalPeriods, {
    fields: [glJournals.periodId],
    references: [fiscalPeriods.id],
  }),
  sourceCode: one(sourceCodes, {
    fields: [glJournals.sourceCodeId],
    references: [sourceCodes.id],
  }),
  reasonCode: one(reasonCodes, {
    fields: [glJournals.reasonCodeId],
    references: [reasonCodes.id],
  }),
  postedByProfile: one(profiles, {
    fields: [glJournals.postedBy],
    references: [profiles.id],
    relationName: "posted_by",
  }),
  approvedByProfile: one(profiles, {
    fields: [glJournals.approvedBy],
    references: [profiles.id],
    relationName: "approved_by",
  }),
  lines: many(glLines),
}));

export const glLinesRelations = relations(glLines, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [glLines.organizationId],
    references: [organizations.id],
  }),
  journal: one(glJournals, {
    fields: [glLines.journalId],
    references: [glJournals.id],
  }),
  account: one(accounts, {
    fields: [glLines.accountId],
    references: [accounts.id],
  }),
  dimensionValues: many(glLineDimensions),
}));

export const glLineDimensionsRelations = relations(
  glLineDimensions,
  ({ one }) => ({
    line: one(glLines, {
      fields: [glLineDimensions.lineId],
      references: [glLines.id],
    }),
    dimension: one(dimensions, {
      fields: [glLineDimensions.dimensionId],
      references: [dimensions.id],
    }),
    value: one(dimensionValues, {
      fields: [glLineDimensions.valueId],
      references: [dimensionValues.id],
    }),
  })
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JournalTemplate = typeof journalTemplates.$inferSelect;
export type NewJournalTemplate = typeof journalTemplates.$inferInsert;
export type JournalBatch = typeof journalBatches.$inferSelect;
export type NewJournalBatch = typeof journalBatches.$inferInsert;
export type GlJournal = typeof glJournals.$inferSelect;
export type NewGlJournal = typeof glJournals.$inferInsert;
export type GlLine = typeof glLines.$inferSelect;
export type NewGlLine = typeof glLines.$inferInsert;
export type GlLineDimension = typeof glLineDimensions.$inferSelect;
export type NewGlLineDimension = typeof glLineDimensions.$inferInsert;
