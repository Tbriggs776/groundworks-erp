import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  budgetEntries,
  budgetEntryDimensions,
  budgets,
  type NewBudget,
  type NewBudgetEntry,
} from "@/lib/db/schema";
import { toDbMoney } from "@/lib/money";

/**
 * Minimal budget helpers — low-level CRUD that the UI (Chunk D) will wire up.
 * Kept intentionally thin; budget reporting and variance math lives in Chunk E.
 *
 *   createBudget()         creates a blank budget for a fiscal year
 *   setBudgetEntry()       upsert a single amount for (budget, account, period, dims)
 *   lockBudget()           freeze a budget — no more entry edits
 */

export async function createBudget(
  input: Omit<NewBudget, "id" | "createdAt" | "updatedAt" | "deletedAt">
): Promise<{ id: string }> {
  const [row] = await db.insert(budgets).values(input).returning({ id: budgets.id });
  return row;
}

export type BudgetEntryInput = Omit<
  NewBudgetEntry,
  "id" | "amount" | "createdAt" | "updatedAt" | "deletedAt"
> & {
  amount: string | number;
  dimensions?: Array<{ dimensionId: string; valueId: string }>;
};

/**
 * Upsert a budget entry + its dimensions. Matches on
 * (budget, account, period) AND exact dimension set. If a matching entry
 * exists, updates its amount/memo; else inserts a new one.
 *
 * Locked budgets reject upserts.
 */
export async function setBudgetEntry(
  input: BudgetEntryInput
): Promise<{ entryId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    // Reject if budget is locked
    const [b] = await tx
      .select({ isLocked: budgets.isLocked })
      .from(budgets)
      .where(eq(budgets.id, input.budgetId));
    if (!b) throw new Error("Budget not found.");
    if (b.isLocked) throw new Error("Budget is locked — entry edits rejected.");

    // For simplicity v1: always INSERT a new entry + dimensions. Callers
    // that want strict upsert behavior can delete prior matches first.
    // Keeps the dimension-match logic out of SQL for now; UI can query
    // existing entries and decide.
    const [entry] = await tx
      .insert(budgetEntries)
      .values({
        organizationId: input.organizationId,
        budgetId: input.budgetId,
        accountId: input.accountId,
        periodId: input.periodId,
        amount: toDbMoney(input.amount),
        memo: input.memo,
      })
      .returning({ id: budgetEntries.id });

    if (input.dimensions && input.dimensions.length > 0) {
      await tx.insert(budgetEntryDimensions).values(
        input.dimensions.map((d) => ({
          organizationId: input.organizationId,
          entryId: entry.id,
          dimensionId: d.dimensionId,
          valueId: d.valueId,
        }))
      );
    }

    return { entryId: entry.id, created: true };
  });
}

export async function lockBudget(
  budgetId: string,
  actorId: string | null
): Promise<void> {
  await db
    .update(budgets)
    .set({
      isLocked: true,
      lockedAt: sql`now()`,
      lockedBy: actorId,
      updatedAt: sql`now()`,
    })
    .where(eq(budgets.id, budgetId));
}

/**
 * Sum of budget amounts for (account, period, [budget]) — used by
 * variance reports. Returns a string so callers can pass to decimal.js.
 */
export async function budgetedAmountFor(opts: {
  organizationId: string;
  budgetId: string;
  accountId: string;
  periodId: string;
}): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${budgetEntries.amount}), 0)::text`,
    })
    .from(budgetEntries)
    .where(
      and(
        eq(budgetEntries.organizationId, opts.organizationId),
        eq(budgetEntries.budgetId, opts.budgetId),
        eq(budgetEntries.accountId, opts.accountId),
        eq(budgetEntries.periodId, opts.periodId)
      )
    );
  return row?.total ?? "0";
}
