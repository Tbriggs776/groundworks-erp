import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { organizations, profiles } from "./identity";
import { fiscalPeriods } from "./periods";

/**
 * MONTH-END CLOSE. The automated checks (reconciliations, drafts, AR / AP
 * tie-out, …) are computed; these are the company's own checklist items
 * ("Review payroll", "Accrue utilities") and who signed each off for which
 * period.
 */
export const closeTasks = pgTable(
  "close_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("close_tasks_org_idx").on(t.organizationId, t.sortOrder)]
);

export const closeTaskCompletions = pgTable(
  "close_task_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodId: uuid("period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => closeTasks.id, { onDelete: "cascade" }),
    completedBy: uuid("completed_by").references(() => profiles.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [uniqueIndex("close_task_completions_key").on(t.periodId, t.taskId)]
);

export type CloseTask = typeof closeTasks.$inferSelect;
export type CloseTaskCompletion = typeof closeTaskCompletions.$inferSelect;
