import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { costType, timestamps } from "./_shared";
import { dimensionValues } from "./dimensions";
import { organizations } from "./identity";

/**
 * COST CODES — the WBS spine for construction accounting. Every AP bill,
 * payroll entry, equipment usage hour, and materials receipt eventually
 * ties to (job, cost_code) so reports can slice cost by phase.
 *
 * We seed the CSI MasterFormat 2018 top-level divisions on org onboarding
 * (opt-in). Tenants can rename, add children, or replace the whole set.
 *
 * Hierarchy: `parent_cost_code_id` is a self-ref. No enforcement of depth —
 * CSI can go 3 levels deep (division → section → subsection).
 *
 * Dimension sync: creating/editing a cost_code mirrors it to a dimension
 * value in the system COST_CODE dimension so GL lines can reference it
 * via the dimension infrastructure. The sync is handled in server actions
 * (src/lib/projects/cost-codes.ts).
 */
export const costCodes = pgTable(
  "cost_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    parentCostCodeId: uuid("parent_cost_code_id").references(
      (): AnyPgColumn => costCodes.id,
      { onDelete: "set null" }
    ),

    costType: costType("cost_type").notNull().default("other"),

    /**
     * Link to the matching dimension_value in the COST_CODE system dimension.
     * Populated when the cost code is created; NOT a source of truth (the
     * dimension value's name/code track this row via the sync helper).
     */
    dimensionValueId: uuid("dimension_value_id").references(
      () => dimensionValues.id,
      { onDelete: "set null" }
    ),

    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),

    externalId: text("external_id"),

    ...timestamps,
  },
  (t) => [uniqueIndex("cost_codes_org_code_key").on(t.organizationId, t.code)]
);

export const costCodesRelations = relations(costCodes, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [costCodes.organizationId],
    references: [organizations.id],
  }),
  parent: one(costCodes, {
    fields: [costCodes.parentCostCodeId],
    references: [costCodes.id],
    relationName: "parent_child",
  }),
  children: many(costCodes, { relationName: "parent_child" }),
  dimensionValue: one(dimensionValues, {
    fields: [costCodes.dimensionValueId],
    references: [dimensionValues.id],
  }),
}));

export type CostCode = typeof costCodes.$inferSelect;
export type NewCostCode = typeof costCodes.$inferInsert;
