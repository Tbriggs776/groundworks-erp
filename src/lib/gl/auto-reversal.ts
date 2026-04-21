import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { glJournals } from "@/lib/db/schema";
import { reverseJournal } from "./posting";

/**
 * Auto-reversal runner. Finds posted journals whose `auto_reverse_date` has
 * arrived and which haven't been reversed yet, then posts a reversing entry
 * dated on the scheduled reverse date.
 *
 * Triggered by:
 *   - /api/cron/daily (Vercel cron, daily at 06:00 UTC)
 *   - Manual admin action ("run due reversals now") in the UI (later)
 *
 * Error policy: failures on individual reversals don't halt the loop —
 * we collect them and return so the caller can log. A reversing-entry
 * failure is almost always a period-status problem (the target period
 * got hard-closed between posting and reversal date) and needs human
 * intervention.
 */
export type AutoReversalResult = {
  checked: number;
  generated: number;
  errors: Array<{ originalId: string; journalNumber: string; error: string }>;
};

export async function runAutoReversalsForOrg(
  organizationId: string,
  asOfDate: string
): Promise<AutoReversalResult> {
  const due = await db
    .select({
      id: glJournals.id,
      number: glJournals.journalNumber,
      autoReverseDate: glJournals.autoReverseDate,
    })
    .from(glJournals)
    .where(
      and(
        eq(glJournals.organizationId, organizationId),
        eq(glJournals.status, "posted"),
        isNull(glJournals.reversedByJournalId),
        lte(glJournals.autoReverseDate, asOfDate),
        // Don't re-reverse a reversing entry itself
        sql`${glJournals.autoReverseDate} IS NOT NULL`
      )
    );

  const result: AutoReversalResult = {
    checked: due.length,
    generated: 0,
    errors: [],
  };

  for (const j of due) {
    const r = await reverseJournal(j.id, {
      actorId: null, // system
      organizationId,
      reversalDate: j.autoReverseDate ?? asOfDate,
      description: `Auto-reversal of ${j.number}`,
    });
    if (r.ok) {
      result.generated++;
    } else {
      result.errors.push({
        originalId: j.id,
        journalNumber: j.number,
        error: `${r.code}: ${r.error}`,
      });
    }
  }

  return result;
}
