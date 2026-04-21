import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  combinationStatus,
  dimensionValuePosting,
  timestamps,
} from "./_shared";
import { accounts } from "./accounts";
import { organizations } from "./identity";

/**
 * DIMENSIONS — analytical slices applied to journal lines. Seeded with
 * system dimensions (JOB, COST_CODE, DEPARTMENT, LOCATION, EQUIPMENT,
 * PROJECT_MANAGER) on org creation; admins may add more.
 *
 * System dimensions:
 *   - `code` is FIXED (subledger modules reference it reliably)
 *   - `name` is tenant-editable (rename "Project Manager" -> "Superintendent")
 *   - `isSystem=true` blocks deletion but not renaming
 */
export const dimensions = pgTable(
  "dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isBlocked: boolean("is_blocked").notNull().default(false),
    isSystem: boolean("is_system").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("dimensions_org_code_key").on(t.organizationId, t.code)]
);

/**
 * DIMENSION VALUES — the atomic values within a dimension. Supports
 * hierarchy via `parentValueId` for rollups (e.g. CSI cost code
 * 03-30-00 -> 03-30-10).
 *
 * `isTotal=true` marks a rollup-only value (no direct posting, children
 * aggregate into it).
 */
export const dimensionValues = pgTable(
  "dimension_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dimensionId: uuid("dimension_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    parentValueId: uuid("parent_value_id").references(
      (): AnyPgColumn => dimensionValues.id,
      { onDelete: "set null" }
    ),
    isBlocked: boolean("is_blocked").notNull().default(false),
    isTotal: boolean("is_total").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("dimension_values_dim_code_key").on(
      t.organizationId,
      t.dimensionId,
      t.code
    ),
    index("dimension_values_parent_idx").on(t.parentValueId),
  ]
);

/**
 * ACCOUNT DEFAULT DIMENSIONS — rules for each (account, dimension) pair:
 *   - `defaultValueId` pre-fills the line on UI
 *   - `valuePosting` controls validation strictness on post:
 *     no_code — dimension must be blank
 *     code_mandatory — dimension must be populated
 *     same_code — must equal default
 *     same_code_and_same_value — rigid match (rare)
 */
export const accountDefaultDimensions = pgTable(
  "account_default_dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    dimensionId: uuid("dimension_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "cascade" }),
    defaultValueId: uuid("default_value_id").references(
      () => dimensionValues.id,
      { onDelete: "set null" }
    ),
    valuePosting: dimensionValuePosting("value_posting")
      .notNull()
      .default("no_code"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("acct_default_dims_key").on(t.accountId, t.dimensionId),
  ]
);

/**
 * DIMENSION COMBINATIONS — allow/block specific pairs of dimension values
 * across two dimensions. e.g., "Cost Code 08-xx is never allowed on Job 101".
 * Default is `allowed` (absence of a row = allowed).
 */
export const dimensionCombinations = pgTable(
  "dimension_combinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dimension1Id: uuid("dimension_1_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "cascade" }),
    value1Id: uuid("value_1_id")
      .notNull()
      .references(() => dimensionValues.id, { onDelete: "cascade" }),
    dimension2Id: uuid("dimension_2_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "cascade" }),
    value2Id: uuid("value_2_id")
      .notNull()
      .references(() => dimensionValues.id, { onDelete: "cascade" }),
    combination: combinationStatus("combination").notNull().default("blocked"),
    reason: text("reason"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("dim_combinations_key").on(
      t.organizationId,
      t.value1Id,
      t.value2Id
    ),
    index("dim_combinations_lookup_idx").on(
      t.organizationId,
      t.dimension1Id,
      t.dimension2Id
    ),
  ]
);

export const dimensionsRelations = relations(dimensions, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [dimensions.organizationId],
    references: [organizations.id],
  }),
  values: many(dimensionValues),
}));

export const dimensionValuesRelations = relations(
  dimensionValues,
  ({ one, many }) => ({
    dimension: one(dimensions, {
      fields: [dimensionValues.dimensionId],
      references: [dimensions.id],
    }),
    parent: one(dimensionValues, {
      fields: [dimensionValues.parentValueId],
      references: [dimensionValues.id],
      relationName: "parent_child",
    }),
    children: many(dimensionValues, { relationName: "parent_child" }),
  })
);

export type Dimension = typeof dimensions.$inferSelect;
export type NewDimension = typeof dimensions.$inferInsert;
export type DimensionValue = typeof dimensionValues.$inferSelect;
export type NewDimensionValue = typeof dimensionValues.$inferInsert;
export type AccountDefaultDimension =
  typeof accountDefaultDimensions.$inferSelect;
export type DimensionCombination = typeof dimensionCombinations.$inferSelect;
