import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { allocationType, timestamps } from "./_shared";
import { accounts } from "./accounts";
import { dimensions, dimensionValues } from "./dimensions";
import { organizations } from "./identity";

/**
 * ALLOCATION GROUPS — named rules for splitting an amount across multiple
 * accounts / dimension combinations. Used for things like:
 *   - "Overhead split by department headcount"
 *   - "Rent split by square footage"
 *   - "Insurance allocated 40/30/30 across three divisions"
 *
 * An allocation run takes a SOURCE amount (typically the net of a source
 * account for a period, or an explicit input) and POSTS a JE that:
 *   - Debits each target account for its % share
 *   - Credits the source account for the total
 *
 * `allocation_type=statistical` uses a statistical account (headcount, SQFT,
 * hours) as the denominator: each target's share = statistical_balance /
 * sum(statistical_balance) × amount. Requires `source_statistical_account_id`.
 *
 * `allocation_type=fixed` uses the static `percent` values on targets. Sum
 * of percents across all targets for a group MUST equal 100.0000 — the
 * app layer validates this on update and on allocation run.
 */
export const allocationGroups = pgTable(
  "allocation_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    allocationType: allocationType("allocation_type").notNull().default("fixed"),
    sourceStatisticalAccountId: uuid("source_statistical_account_id").references(
      () => accounts.id,
      { onDelete: "restrict" }
    ),

    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("allocation_groups_org_code_key").on(t.organizationId, t.code),
  ]
);

/**
 * ALLOCATION TARGETS — per (group, account) destinations. Dimensions on
 * the target travel to the generated JE line via allocation_target_dimensions.
 */
export const allocationTargets = pgTable(
  "allocation_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    allocationGroupId: uuid("allocation_group_id")
      .notNull()
      .references(() => allocationGroups.id, { onDelete: "cascade" }),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    percent: numeric("percent", { precision: 10, scale: 6 })
      .notNull()
      .default("0"),

    memo: text("memo"),
    ...timestamps,
  },
  (t) => [
    index("allocation_targets_group_idx").on(t.allocationGroupId),
  ]
);

/**
 * ALLOCATION TARGET DIMENSIONS — dimension values that ride with each
 * generated allocation JE line. Mirrors gl_line_dimensions shape.
 */
export const allocationTargetDimensions = pgTable(
  "allocation_target_dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => allocationTargets.id, { onDelete: "cascade" }),
    dimensionId: uuid("dimension_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "restrict" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => dimensionValues.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("allocation_target_dims_key").on(t.targetId, t.dimensionId),
  ]
);

export const allocationGroupsRelations = relations(
  allocationGroups,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [allocationGroups.organizationId],
      references: [organizations.id],
    }),
    sourceStatisticalAccount: one(accounts, {
      fields: [allocationGroups.sourceStatisticalAccountId],
      references: [accounts.id],
    }),
    targets: many(allocationTargets),
  })
);

export const allocationTargetsRelations = relations(
  allocationTargets,
  ({ one, many }) => ({
    group: one(allocationGroups, {
      fields: [allocationTargets.allocationGroupId],
      references: [allocationGroups.id],
    }),
    account: one(accounts, {
      fields: [allocationTargets.accountId],
      references: [accounts.id],
    }),
    dimensionValues: many(allocationTargetDimensions),
  })
);

export type AllocationGroup = typeof allocationGroups.$inferSelect;
export type NewAllocationGroup = typeof allocationGroups.$inferInsert;
export type AllocationTarget = typeof allocationTargets.$inferSelect;
export type NewAllocationTarget = typeof allocationTargets.$inferInsert;
export type AllocationTargetDimension =
  typeof allocationTargetDimensions.$inferSelect;
