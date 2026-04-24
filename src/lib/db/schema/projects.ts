import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jobStatus, timestamps } from "./_shared";
import { costCodes } from "./cost_codes";
import { customers } from "./parties";
import { dimensionValues } from "./dimensions";
import { organizations, profiles } from "./identity";

/**
 * CONTRACT TYPES — tenant-configurable classification of how a job's revenue
 * gets recognized and billed. System defaults seeded on org creation
 * (lump_sum, t_and_m, cost_plus, unit_price, guaranteed_max). Admins can
 * rename, add, or deactivate any of them (including system rows — only
 * deletion is blocked on system rows).
 */
export const contractTypes = pgTable(
  "contract_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),

    ...timestamps,
  },
  (t) => [uniqueIndex("contract_types_org_code_key").on(t.organizationId, t.code)]
);

/**
 * JOBS — the core construction project record. Each job rolls up its own
 * cost codes (via job_cost_codes with per-job budgets), has a customer,
 * optional PM, status state machine, contract terms.
 *
 * Dimension sync: every job auto-creates a matching dimension_value in the
 * JOB system dimension (code = job.code, name = job.name), handled in the
 * createJob / updateJob server actions. Deleting a job soft-deletes the
 * row but leaves the dimension value in place so historical GL entries
 * still resolve.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    code: text("code").notNull(), // job number
    name: text("name").notNull(),
    description: text("description"),

    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    projectManagerId: uuid("project_manager_id").references(() => profiles.id, {
      onDelete: "set null",
    }),

    status: jobStatus("status").notNull().default("bid"),

    contractTypeId: uuid("contract_type_id").references(() => contractTypes.id, {
      onDelete: "set null",
    }),
    contractAmount: numeric("contract_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    contractDate: date("contract_date"),

    startDate: date("start_date"),
    estimatedEndDate: date("estimated_end_date"),
    actualEndDate: date("actual_end_date"),

    // Job-site + billing addresses stored as flexible JSON (see parties.ts
    // for the Address shape — same convention).
    addresses: jsonb("addresses").notNull().default([]),

    // Default retainage on draws. Stored as percent (e.g. 10.0000 = 10%).
    retainagePercent: numeric("retainage_percent", {
      precision: 10,
      scale: 6,
    })
      .notNull()
      .default("0"),

    /** Link to the matching dimension_value in the JOB system dimension. */
    dimensionValueId: uuid("dimension_value_id").references(
      () => dimensionValues.id,
      { onDelete: "set null" }
    ),

    // Status transitions are logged via audit_log. These snapshot the last
    // transition for convenience.
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    statusChangedBy: uuid("status_changed_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),

    ...timestamps,
  },
  (t) => [uniqueIndex("jobs_org_code_key").on(t.organizationId, t.code)]
);

/**
 * JOB COST CODES — per-job budget × cost code. The join is where the
 * project-specific WBS lives: a job uses a subset of the org's cost codes
 * with its own budget amount per code.
 *
 * `committedAmount` and `actualAmount` will be populated from commitments
 * (POs, subcontracts) and gl_lines (actuals) when those modules land. For
 * v1 they're just numeric columns initialized to 0.
 */
export const jobCostCodes = pgTable(
  "job_cost_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    costCodeId: uuid("cost_code_id")
      .notNull()
      .references(() => costCodes.id, { onDelete: "restrict" }),

    budgetAmount: numeric("budget_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    // Computed from commitments (POs / subcontracts) — populated later.
    committedAmount: numeric("committed_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    // Computed from gl_lines (actuals) — populated by AP/payroll later.
    actualAmount: numeric("actual_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),

    notes: text("notes"),

    ...timestamps,
  },
  (t) => [uniqueIndex("job_cost_codes_unique").on(t.jobId, t.costCodeId)]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const contractTypesRelations = relations(contractTypes, ({ one }) => ({
  organization: one(organizations, {
    fields: [contractTypes.organizationId],
    references: [organizations.id],
  }),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [jobs.organizationId],
    references: [organizations.id],
  }),
  customer: one(customers, {
    fields: [jobs.customerId],
    references: [customers.id],
  }),
  projectManager: one(profiles, {
    fields: [jobs.projectManagerId],
    references: [profiles.id],
  }),
  contractType: one(contractTypes, {
    fields: [jobs.contractTypeId],
    references: [contractTypes.id],
  }),
  dimensionValue: one(dimensionValues, {
    fields: [jobs.dimensionValueId],
    references: [dimensionValues.id],
  }),
  costCodes: many(jobCostCodes),
}));

export const jobCostCodesRelations = relations(jobCostCodes, ({ one }) => ({
  job: one(jobs, { fields: [jobCostCodes.jobId], references: [jobs.id] }),
  costCode: one(costCodes, {
    fields: [jobCostCodes.costCodeId],
    references: [costCodes.id],
  }),
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContractType = typeof contractTypes.$inferSelect;
export type NewContractType = typeof contractTypes.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobCostCode = typeof jobCostCodes.$inferSelect;
export type NewJobCostCode = typeof jobCostCodes.$inferInsert;
