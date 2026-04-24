import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { approvalScope, membershipRole, timestamps } from "./_shared";
import { organizations } from "./identity";

/**
 * APPROVAL THRESHOLDS — amount-tier rules that drive who must approve what.
 * Per-org, per-scope (ap_bill today, more scopes later). Amount comparisons
 * are INCLUSIVE on min, EXCLUSIVE on max: a tier with min=0 max=5000 fires
 * for amounts 0..4999.99. Max NULL means unbounded (the top tier).
 *
 * The required_role is a MINIMUM — anyone with a higher rank can also
 * approve (owner > admin > accountant > pm > foreman > viewer). That
 * matches how most real approval chains work: a senior signatory can
 * always step in for a junior one.
 *
 * Defaults seeded on org creation: one tier with min=0, max=NULL,
 * required_role=admin — meaning every bill needs admin sign-off.
 * Admins can rewrite or tier-down via /settings/approval-thresholds.
 */
export const approvalThresholds = pgTable(
  "approval_thresholds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    scope: approvalScope("scope").notNull().default("ap_bill"),
    tierName: text("tier_name").notNull(),

    minAmount: numeric("min_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    maxAmount: numeric("max_amount", { precision: 20, scale: 4 }),

    requiredRole: membershipRole("required_role").notNull().default("admin"),

    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("approval_thresholds_org_scope_name_key").on(
      t.organizationId,
      t.scope,
      t.tierName
    ),
  ]
);

export const approvalThresholdsRelations = relations(
  approvalThresholds,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [approvalThresholds.organizationId],
      references: [organizations.id],
    }),
  })
);

export type ApprovalThreshold = typeof approvalThresholds.$inferSelect;
export type NewApprovalThreshold = typeof approvalThresholds.$inferInsert;
