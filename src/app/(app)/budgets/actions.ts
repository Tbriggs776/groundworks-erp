"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { budgetEntries, budgets } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import {
  createBudget as createBudgetHelper,
  lockBudget as lockBudgetHelper,
  setBudgetEntry as setBudgetEntryHelper,
} from "@/lib/gl/budgets";

const CreateSchema = z.object({
  fiscalYearId: z.string().uuid(),
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional().or(z.literal("")),
});

export type ActionResult<T = { id: string }> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export async function createBudget(
  input: z.infer<typeof CreateSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const row = await createBudgetHelper({
      organizationId,
      fiscalYearId: parsed.data.fiscalYearId,
      code: parsed.data.code,
      name: parsed.data.name,
      description: parsed.data.description || null,
    });
    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "budget.created",
      entityType: "budget",
      entityId: row.id,
      metadata: { code: parsed.data.code },
    });
    revalidatePath("/budgets");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already in use.` };
    }
    console.error("[budgets] createBudget failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function addBudgetEntry(input: {
  budgetId: string;
  accountId: string;
  periodId: string;
  amount: string;
  memo?: string;
}): Promise<ActionResult<{ entryId: string }>> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  try {
    const r = await setBudgetEntryHelper({
      organizationId,
      budgetId: input.budgetId,
      accountId: input.accountId,
      periodId: input.periodId,
      amount: input.amount,
      memo: input.memo,
    });
    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "budget.entry.created",
      entityType: "budget_entry",
      entityId: r.entryId,
      metadata: {
        budgetId: input.budgetId,
        accountId: input.accountId,
        periodId: input.periodId,
        amount: input.amount,
      },
    });
    revalidatePath(`/budgets/${input.budgetId}`);
    return { ok: true, entryId: r.entryId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteBudgetEntry(
  entryId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const [entry] = await db
    .select({ budgetId: budgetEntries.budgetId })
    .from(budgetEntries)
    .where(
      and(
        eq(budgetEntries.id, entryId),
        eq(budgetEntries.organizationId, organizationId)
      )
    );
  if (!entry) return { ok: false, error: "Entry not found." };

  // Reject if the budget is locked
  const [b] = await db
    .select({ isLocked: budgets.isLocked })
    .from(budgets)
    .where(eq(budgets.id, entry.budgetId));
  if (b?.isLocked)
    return { ok: false, error: "Budget is locked; unlock first." };

  await db.delete(budgetEntries).where(eq(budgetEntries.id, entryId));
  await writeAudit({
    organizationId,
    actorId: actor?.id ?? null,
    event: "budget.entry.deleted",
    entityType: "budget_entry",
    entityId: entryId,
    metadata: {},
  });
  revalidatePath(`/budgets/${entry.budgetId}`);
  return { ok: true, id: entryId };
}

export async function setBudgetLock(
  budgetId: string,
  locked: boolean
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  if (locked) {
    await lockBudgetHelper(budgetId, actor?.id ?? null);
  } else {
    await db
      .update(budgets)
      .set({
        isLocked: false,
        lockedAt: null,
        lockedBy: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(budgets.id, budgetId),
          eq(budgets.organizationId, organizationId)
        )
      );
  }

  await writeAudit({
    organizationId,
    actorId: actor?.id ?? null,
    event: locked ? "budget.locked" : "budget.unlocked",
    entityType: "budget",
    entityId: budgetId,
    metadata: {},
  });

  revalidatePath(`/budgets/${budgetId}`);
  return { ok: true, id: budgetId };
}
