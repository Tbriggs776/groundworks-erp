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
  accountCategory,
  accountSubcategory,
  accountType,
  debitCreditEnforced,
  normalBalance,
  timestamps,
} from "./_shared";
import { organizations } from "./identity";
import { currencies } from "./finance";

/**
 * ACCOUNT CATEGORIES — user-editable display groupings used to build
 * financial statement layouts. Separate from `subcategory` on accounts:
 * subcategory is a fixed taxonomy; categories are a tenant's custom
 * report organization.
 *
 * Example hierarchy:
 *   Assets (root, category=balance_sheet)
 *     Current Assets
 *       Cash
 *       Receivables
 *     Fixed Assets
 *       PP&E
 *       Accumulated Depreciation
 */
export const accountCategories = pgTable(
  "account_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: accountCategory("category").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => accountCategories.id, {
      onDelete: "set null",
    }),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("account_categories_org_idx").on(t.organizationId, t.category),
    index("account_categories_parent_idx").on(t.parentId),
  ]
);

/**
 * ACCOUNTS — the Chart of Accounts. Tenant-scoped. Flat structure (no
 * segmented codes) — dimensions provide analytical breakdowns.
 *
 * Posting rules enforced by the posting function (Chunk B):
 *  - `accountType='posting'` required for journal lines
 *  - `directPosting=false` blocks manual entry; only subledgers (AR/AP/
 *    inventory) can hit the account
 *  - `isBlocked=true` stops all new posting but preserves history
 *  - `debitCreditEnforced` restricts which side of the entry may be used
 *  - `currency!=null` restricts the account to a single currency (e.g.
 *    EUR-denominated bank account)
 *  - `isControl=true` flags AR/AP/Inventory/WIP control accounts — posting
 *    function blocks manual lines; only subledger-sourced journals allowed
 *  - `isCash=true` flags cash/bank accounts for bank reconciliation
 *  - `isStatistical=true` flags non-monetary quantity accounts (headcount,
 *    sqft, hours) used by allocation formulas — not included in financial
 *    statements
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    // BC-style structure
    accountType: accountType("account_type").notNull().default("posting"),
    totaling: text("totaling"),
    indentation: integer("indentation").notNull().default(0),

    // Classification
    category: accountCategory("category").notNull(),
    subcategory: accountSubcategory("subcategory").notNull(),
    normalBalance: normalBalance("normal_balance").notNull(),
    categoryId: uuid("category_id").references(() => accountCategories.id, {
      onDelete: "set null",
    }),

    // Posting rules
    directPosting: boolean("direct_posting").notNull().default(true),
    isBlocked: boolean("is_blocked").notNull().default(false),
    isControl: boolean("is_control").notNull().default(false),
    isCash: boolean("is_cash").notNull().default(false),
    isReconciliation: boolean("is_reconciliation").notNull().default(false),
    isStatistical: boolean("is_statistical").notNull().default(false),
    debitCreditEnforced: debitCreditEnforced("debit_credit_enforced")
      .notNull()
      .default("either"),

    // Currency
    currency: text("currency").references(() => currencies.code),

    // Metadata
    isActive: boolean("is_active").notNull().default(true),
    externalId: text("external_id"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("accounts_org_code_key").on(t.organizationId, t.code),
    index("accounts_org_active_idx").on(t.organizationId, t.isActive, t.isBlocked),
    index("accounts_org_category_idx").on(t.organizationId, t.category),
    index("accounts_org_subcategory_idx").on(t.organizationId, t.subcategory),
    index("accounts_control_idx").on(t.organizationId, t.isControl),
  ]
);

export const accountCategoriesRelations = relations(
  accountCategories,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [accountCategories.organizationId],
      references: [organizations.id],
    }),
    parent: one(accountCategories, {
      fields: [accountCategories.parentId],
      references: [accountCategories.id],
      relationName: "parent_child",
    }),
    children: many(accountCategories, { relationName: "parent_child" }),
    accounts: many(accounts),
  })
);

export const accountsRelations = relations(accounts, ({ one }) => ({
  organization: one(organizations, {
    fields: [accounts.organizationId],
    references: [organizations.id],
  }),
  category: one(accountCategories, {
    fields: [accounts.categoryId],
    references: [accountCategories.id],
  }),
  currencyRef: one(currencies, {
    fields: [accounts.currency],
    references: [currencies.code],
  }),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type AccountCategory = typeof accountCategories.$inferSelect;
export type NewAccountCategory = typeof accountCategories.$inferInsert;
