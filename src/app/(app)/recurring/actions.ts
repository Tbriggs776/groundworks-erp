"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  journalTemplates,
  numberSeries,
  recurringJournalLines,
  recurringJournals,
  sourceCodes,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import { runRecurringForOrg } from "@/lib/gl/recurring";
import { toDbMoney } from "@/lib/money";

const LineSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: z.string().trim(),
    credit: z.string().trim(),
    memo: z.string().trim().optional().or(z.literal("")),
  })
  .refine(
    (l) => {
      const d = Number(l.debit || 0);
      const c = Number(l.credit || 0);
      return (d > 0 && c === 0) || (c > 0 && d === 0);
    },
    { message: "Each line must have either a debit or a credit (not both)." }
  );

const FREQUENCY_VALUES = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "semiannually",
  "annually",
] as const;

const RecurringSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  journalDescription: z.string().trim().min(1).max(500),
  frequency: z.enum(FREQUENCY_VALUES),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  nextRunDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().default("USD"),
  status: z.enum(["active", "paused", "ended"]).default("active"),
  lines: z.array(LineSchema).min(2),
});

export type RecurringInput = z.infer<typeof RecurringSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Ensure a baseline "General Journal" template exists for this org so that
 * recurring rows have something to attach to. Returns its id. Idempotent.
 */
async function ensureDefaultTemplate(organizationId: string): Promise<string> {
  const [existing] = await db
    .select({ id: journalTemplates.id })
    .from(journalTemplates)
    .where(
      and(
        eq(journalTemplates.organizationId, organizationId),
        eq(journalTemplates.code, "GJ")
      )
    );
  if (existing) return existing.id;

  const [gjSource] = await db
    .select({ id: sourceCodes.id })
    .from(sourceCodes)
    .where(
      and(
        eq(sourceCodes.organizationId, organizationId),
        eq(sourceCodes.code, "GJ")
      )
    );
  const [recSeries] = await db
    .select({ id: numberSeries.id })
    .from(numberSeries)
    .where(
      and(
        eq(numberSeries.organizationId, organizationId),
        eq(numberSeries.code, "REC")
      )
    );
  if (!gjSource || !recSeries) {
    throw new Error(
      "GJ source code or REC number series missing. Re-run onboarding seeders."
    );
  }

  const [row] = await db
    .insert(journalTemplates)
    .values({
      organizationId,
      code: "GJ",
      name: "General Journal",
      sourceCodeId: gjSource.id,
      numberSeriesId: recSeries.id,
    })
    .returning({ id: journalTemplates.id });
  return row.id;
}

export async function createRecurring(
  input: RecurringInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = RecurringSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    const templateId = await ensureDefaultTemplate(organizationId);

    const id = await db.transaction(async (tx) => {
      const [rec] = await tx
        .insert(recurringJournals)
        .values({
          organizationId,
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description || null,
          journalTemplateId: templateId,
          journalDescription: parsed.data.journalDescription,
          frequency: parsed.data.frequency,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate || null,
          nextRunDate: parsed.data.nextRunDate,
          currency: parsed.data.currency,
          status: parsed.data.status,
          createdBy: actor?.id ?? null,
        })
        .returning({ id: recurringJournals.id });

      await tx.insert(recurringJournalLines).values(
        parsed.data.lines.map((l, i) => ({
          organizationId,
          recurringJournalId: rec.id,
          lineNumber: i + 1,
          accountId: l.accountId,
          debit: toDbMoney(l.debit || "0"),
          credit: toDbMoney(l.credit || "0"),
          memo: l.memo || null,
        }))
      );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "recurring.created",
          entityType: "recurring_journal",
          entityId: rec.id,
          metadata: { code: parsed.data.code, frequency: parsed.data.frequency },
        },
        tx
      );

      return rec.id;
    });

    revalidatePath("/recurring");
    return { ok: true, id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already in use.` };
    }
    console.error("[recurring] createRecurring failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateRecurring(
  recurringId: string,
  input: RecurringInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = RecurringSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(recurringJournals)
        .set({
          code: parsed.data.code,
          name: parsed.data.name,
          description: parsed.data.description || null,
          journalDescription: parsed.data.journalDescription,
          frequency: parsed.data.frequency,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate || null,
          nextRunDate: parsed.data.nextRunDate,
          currency: parsed.data.currency,
          status: parsed.data.status,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(recurringJournals.id, recurringId),
            eq(recurringJournals.organizationId, organizationId)
          )
        );

      // Replace lines: delete + re-insert (simpler than diffing, and
      // recurring lines are a template so history on them isn't meaningful).
      await tx
        .delete(recurringJournalLines)
        .where(eq(recurringJournalLines.recurringJournalId, recurringId));

      await tx.insert(recurringJournalLines).values(
        parsed.data.lines.map((l, i) => ({
          organizationId,
          recurringJournalId: recurringId,
          lineNumber: i + 1,
          accountId: l.accountId,
          debit: toDbMoney(l.debit || "0"),
          credit: toDbMoney(l.credit || "0"),
          memo: l.memo || null,
        }))
      );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "recurring.updated",
          entityType: "recurring_journal",
          entityId: recurringId,
          metadata: { code: parsed.data.code },
        },
        tx
      );
    });

    revalidatePath("/recurring");
    revalidatePath(`/recurring/${recurringId}`);
    return { ok: true, id: recurringId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `Code "${parsed.data.code}" already in use.` };
    }
    console.error("[recurring] updateRecurring failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Run the recurring scheduler on demand for the current org, asOfDate=today.
 * Returns a summary. Gated to accountant+.
 */
export async function runRecurringNow(): Promise<
  | { ok: true; generated: number; checked: number; errors: string[] }
  | { ok: false; error: string }
> {
  const { organizationId } = await requireRole("accountant");
  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = await runRecurringForOrg(organizationId, today);
    revalidatePath("/recurring");
    revalidatePath("/gl");
    return {
      ok: true,
      generated: result.generated,
      checked: result.checked,
      errors: result.errors.map((e) => `${e.code}: ${e.error}`),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
