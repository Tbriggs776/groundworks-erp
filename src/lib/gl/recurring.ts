import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  format,
  isAfter,
  parseISO,
} from "date-fns";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  journalTemplates,
  recurringJournalLines,
  recurringJournals,
  recurringLineDimensions,
  sourceCodes,
} from "@/lib/db/schema";
import { createAndPostJournal, type JournalLineInput } from "./posting";

/**
 * Advance a date by one recurring-cadence interval. Pure — doesn't touch
 * the DB.
 */
export function advanceRecurringDate(
  current: Date,
  frequency:
    | "daily"
    | "weekly"
    | "biweekly"
    | "monthly"
    | "quarterly"
    | "semiannually"
    | "annually"
): Date {
  switch (frequency) {
    case "daily":
      return addDays(current, 1);
    case "weekly":
      return addWeeks(current, 1);
    case "biweekly":
      return addWeeks(current, 2);
    case "monthly":
      return addMonths(current, 1);
    case "quarterly":
      return addMonths(current, 3);
    case "semiannually":
      return addMonths(current, 6);
    case "annually":
      return addYears(current, 1);
  }
}

export type RecurringRunResult = {
  checked: number;
  generated: number;
  errors: Array<{ recurringId: string; code: string; error: string }>;
};

/**
 * Recurring-journal runner. Finds all `active` recurring rows whose
 * `next_run_date` has arrived, generates a balanced JE from each template,
 * posts it via `createAndPostJournal`, and advances the schedule.
 *
 *   - Each recurring run is its own transaction — a failure on one recurring
 *     doesn't block the next. Failures are captured in `errors`.
 *   - If the new next_run_date would pass end_date, the recurring transitions
 *     to `ended` and stops.
 *   - `last_run_journal_id` back-links the most recent generated JE.
 */
export async function runRecurringForOrg(
  organizationId: string,
  asOfDate: string
): Promise<RecurringRunResult> {
  const due = await db
    .select()
    .from(recurringJournals)
    .where(
      and(
        eq(recurringJournals.organizationId, organizationId),
        eq(recurringJournals.status, "active"),
        lte(recurringJournals.nextRunDate, asOfDate)
      )
    );

  const result: RecurringRunResult = {
    checked: due.length,
    generated: 0,
    errors: [],
  };

  for (const rec of due) {
    try {
      // Pull the template for source_code and number_series wiring.
      const [tmpl] = await db
        .select()
        .from(journalTemplates)
        .where(eq(journalTemplates.id, rec.journalTemplateId));
      if (!tmpl) throw new Error("Journal template missing.");

      // Pull the source_code so we have its string code (we need this for
      // the JE's source enum) and its id (sourceCodeId).
      const [src] = await db
        .select()
        .from(sourceCodes)
        .where(eq(sourceCodes.id, tmpl.sourceCodeId));

      // Pull the template's lines + dimension values.
      const lines = await db
        .select()
        .from(recurringJournalLines)
        .where(eq(recurringJournalLines.recurringJournalId, rec.id))
        .orderBy(recurringJournalLines.lineNumber);

      const lineDims = await db
        .select()
        .from(recurringLineDimensions)
        .where(
          sql`${recurringLineDimensions.lineId} IN (SELECT id FROM ${recurringJournalLines} WHERE recurring_journal_id = ${rec.id})`
        );

      const dimsByLine = new Map<
        string,
        Array<{ dimensionId: string; valueId: string }>
      >();
      for (const d of lineDims) {
        const arr = dimsByLine.get(d.lineId) ?? [];
        arr.push({ dimensionId: d.dimensionId, valueId: d.valueId });
        dimsByLine.set(d.lineId, arr);
      }

      const jeLines: JournalLineInput[] = lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo ?? undefined,
        reference: l.reference ?? undefined,
        jobId: l.jobId ?? undefined,
        costCodeId: l.costCodeId ?? undefined,
        customerId: l.customerId ?? undefined,
        vendorId: l.vendorId ?? undefined,
        employeeId: l.employeeId ?? undefined,
        fixedAssetId: l.fixedAssetId ?? undefined,
        bankAccountId: l.bankAccountId ?? undefined,
        dimensions: dimsByLine.get(l.id),
      }));

      const posted = await createAndPostJournal({
        organizationId,
        actorId: null, // system
        journalDate: rec.nextRunDate,
        sourceCodeId: tmpl.sourceCodeId,
        source: "recurring",
        description: rec.journalDescription,
        reasonCodeId: rec.reasonCodeId ?? undefined,
        currency: rec.currency,
        lines: jeLines,
        templateId: rec.journalTemplateId,
        numberSeriesCode: src?.code === "REC" ? "REC" : "JE",
      });

      if (!posted.ok) {
        throw new Error(`${posted.code}: ${posted.error}`);
      }

      // Advance schedule. parseISO anchors to LOCAL midnight; plain
      // `new Date("YYYY-MM-DD")` parses as UTC midnight which gets shifted
      // to the previous day in negative-offset timezones.
      const next = advanceRecurringDate(
        parseISO(rec.nextRunDate),
        rec.frequency
      );
      const ended = rec.endDate
        ? isAfter(next, parseISO(rec.endDate))
        : false;

      await db
        .update(recurringJournals)
        .set({
          lastRunDate: rec.nextRunDate,
          lastRunJournalId: posted.journalId,
          nextRunDate: format(next, "yyyy-MM-dd"),
          status: ended ? "ended" : "active",
          updatedAt: sql`now()`,
        })
        .where(eq(recurringJournals.id, rec.id));

      result.generated++;
    } catch (e) {
      result.errors.push({
        recurringId: rec.id,
        code: rec.code,
        error: (e as Error).message,
      });
    }
  }

  return result;
}
