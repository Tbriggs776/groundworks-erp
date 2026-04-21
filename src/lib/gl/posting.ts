import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  glJournals,
  glLineDimensions,
  glLines,
  type NewGlJournal,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { toDbMoney } from "@/lib/money";
import { nextNumber } from "./number-series";
import {
  resolvePeriodId,
  toLocal,
  validateJournalForPost,
  type ValidationResult,
} from "./validations";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export type JournalLineInput = {
  accountId: string;
  debit?: string | number;
  credit?: string | number;
  memo?: string;
  reference?: string;
  jobId?: string;
  costCodeId?: string;
  customerId?: string;
  vendorId?: string;
  employeeId?: string;
  fixedAssetId?: string;
  bankAccountId?: string;
  dimensions?: Array<{ dimensionId: string; valueId: string }>;
};

export type CreateAndPostInput = {
  organizationId: string;
  actorId: string;
  journalDate: string; // ISO date YYYY-MM-DD
  sourceCodeId: string;
  source: NewGlJournal["source"];
  description: string;
  reasonCodeId?: string;
  currency?: string;
  exchangeRate?: string;
  lines: JournalLineInput[];
  batchId?: string;
  templateId?: string;
  documentNo?: string;
  reversesJournalId?: string;
  autoReverseDate?: string;
  // Hard-close override
  overridePassword?: string;
  overrideReason?: string;
  // Number series code; defaults based on source
  numberSeriesCode?: string;
};

export type PostResult =
  | { ok: true; journalId: string; journalNumber: string }
  | { ok: false; error: string; code: string; meta?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a draft journal and post it atomically. All 11 validations run
 * inside the same transaction as the post; any failure rolls back every
 * write, including the draft itself.
 *
 * The usual entry point for:
 *   - Manual journal entry UI (Chunk D)
 *   - Subledger posts (AP bill approval, AR invoice issue, payroll run)
 *   - Reversing entries (via `reverseJournal`)
 */
export async function createAndPostJournal(
  input: CreateAndPostInput
): Promise<PostResult> {
  return db.transaction(async (tx) => {
    const draft = await createDraftJournal(tx, input);
    return postDraft(tx, {
      journalId: draft.journalId,
      journalNumber: draft.journalNumber,
      actorId: input.actorId,
      organizationId: input.organizationId,
      overridePassword: input.overridePassword,
      overrideReason: input.overrideReason,
    });
  });
}

/**
 * Create the draft header + lines + line-dimension rows. Does NOT post.
 * Returns the draft's id and allocated journal_number.
 */
export async function createDraftJournal(
  tx: Tx,
  input: CreateAndPostInput
): Promise<{ journalId: string; journalNumber: string }> {
  // Allocate journal number atomically
  const seriesCode = input.numberSeriesCode ?? defaultSeriesForSource(input.source);
  const journalNumber = await nextNumber(
    tx,
    input.organizationId,
    seriesCode
  );

  // Resolve the period
  const periodId = await resolvePeriodId(
    tx,
    input.organizationId,
    input.journalDate
  );

  const currency = input.currency ?? "USD";
  const exchangeRate = input.exchangeRate ?? "1";

  const [header] = await tx
    .insert(glJournals)
    .values({
      organizationId: input.organizationId,
      batchId: input.batchId,
      journalTemplateId: input.templateId,
      journalNumber,
      documentNo: input.documentNo,
      journalDate: input.journalDate,
      periodId,
      sourceCodeId: input.sourceCodeId,
      source: input.source,
      reasonCodeId: input.reasonCodeId,
      description: input.description,
      status: "draft",
      reversesJournalId: input.reversesJournalId,
      autoReverseDate: input.autoReverseDate,
      currency,
      exchangeRate,
    })
    .returning({ id: glJournals.id });

  // Insert lines
  for (let i = 0; i < input.lines.length; i++) {
    const ln = input.lines[i];
    const debit = ln.debit ? toDbMoney(ln.debit) : "0";
    const credit = ln.credit ? toDbMoney(ln.credit) : "0";
    // Mirror to local. If rate = 1, they equal the journal-currency amount.
    const debitLocal = debit === "0.0000" ? "0" : toLocal(debit, exchangeRate);
    const creditLocal =
      credit === "0.0000" ? "0" : toLocal(credit, exchangeRate);

    const [line] = await tx
      .insert(glLines)
      .values({
        organizationId: input.organizationId,
        journalId: header.id,
        lineNumber: i + 1,
        accountId: ln.accountId,
        debit,
        credit,
        debitLocal,
        creditLocal,
        memo: ln.memo,
        reference: ln.reference,
        jobId: ln.jobId,
        costCodeId: ln.costCodeId,
        customerId: ln.customerId,
        vendorId: ln.vendorId,
        employeeId: ln.employeeId,
        fixedAssetId: ln.fixedAssetId,
        bankAccountId: ln.bankAccountId,
      })
      .returning({ id: glLines.id });

    if (ln.dimensions && ln.dimensions.length > 0) {
      await tx.insert(glLineDimensions).values(
        ln.dimensions.map((d) => ({
          organizationId: input.organizationId,
          lineId: line.id,
          dimensionId: d.dimensionId,
          valueId: d.valueId,
        }))
      );
    }
  }

  return { journalId: header.id, journalNumber };
}

/**
 * Post an existing draft journal. Runs all 11 validations; on success sets
 * status='posted', stamps posted_at/posted_by, writes an audit row, and —
 * if this is a reversing journal — updates the original's
 * reversed_by_journal_id.
 */
export async function postDraft(
  tx: Tx,
  opts: {
    journalId: string;
    journalNumber?: string;
    actorId: string;
    organizationId: string;
    overridePassword?: string;
    overrideReason?: string;
  }
): Promise<PostResult> {
  const validation: ValidationResult = await validateJournalForPost(
    tx,
    opts.journalId,
    opts
  );
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      error: validation.message,
      meta: validation.meta,
    };
  }

  // Determine whether we're overriding a hard-closed period (captured for
  // both the journal row and the audit trail).
  const overrideUsed = Boolean(opts.overridePassword);

  const [updated] = await tx
    .update(glJournals)
    .set({
      status: "posted",
      postedAt: sql`now()`,
      postedBy: opts.actorId,
      overrideHardClose: overrideUsed,
      overrideReason: overrideUsed ? opts.overrideReason : null,
      overrideApprovedBy: overrideUsed ? opts.actorId : null,
      updatedAt: sql`now()`,
    })
    .where(eq(glJournals.id, opts.journalId))
    .returning({
      id: glJournals.id,
      number: glJournals.journalNumber,
      reversesJournalId: glJournals.reversesJournalId,
      source: glJournals.source,
    });

  // If this is a reversal, link the original.
  if (updated.reversesJournalId) {
    await tx
      .update(glJournals)
      .set({
        reversedByJournalId: updated.id,
        status: "reversed",
        updatedAt: sql`now()`,
      })
      .where(eq(glJournals.id, updated.reversesJournalId));
  }

  await writeAudit(
    {
      organizationId: opts.organizationId,
      actorId: opts.actorId,
      event: overrideUsed ? "gl.period.override_post" : "gl.journal.posted",
      entityType: "gl_journal",
      entityId: updated.id,
      metadata: {
        journalNumber: updated.number,
        source: updated.source,
        overrideUsed,
        overrideReason: overrideUsed ? opts.overrideReason : undefined,
        reversesJournalId: updated.reversesJournalId ?? undefined,
      },
    },
    tx
  );

  return { ok: true, journalId: updated.id, journalNumber: updated.number };
}

/**
 * Reverse a posted journal. Creates a new journal that mirrors the original's
 * lines with debits and credits swapped, posts it atomically, and links the
 * pair via reverses_journal_id / reversed_by_journal_id.
 */
export async function reverseJournal(
  originalId: string,
  opts: {
    actorId: string;
    organizationId: string;
    reversalDate?: string; // default: today
    description?: string; // default: "Reversal of <original number>"
    reasonCodeId?: string;
    overridePassword?: string;
    overrideReason?: string;
  }
): Promise<PostResult> {
  return db.transaction(async (tx) => {
    const [orig] = await tx
      .select({
        id: glJournals.id,
        number: glJournals.journalNumber,
        currency: glJournals.currency,
        exchangeRate: glJournals.exchangeRate,
        status: glJournals.status,
        reversedBy: glJournals.reversedByJournalId,
        source: glJournals.source,
      })
      .from(glJournals)
      .where(eq(glJournals.id, originalId));

    if (!orig) {
      return { ok: false, code: "original_not_found", error: "Original journal not found." };
    }
    // Check "already reversed" BEFORE the status check — a reversed journal
    // has status='reversed' (not 'posted'), so the status check would win
    // and surface the wrong error.
    if (orig.reversedBy || orig.status === "reversed") {
      return {
        ok: false,
        code: "already_reversed",
        error: "Journal has already been reversed.",
      };
    }
    if (orig.status !== "posted") {
      return {
        ok: false,
        code: "original_not_posted",
        error: "Only posted journals can be reversed.",
      };
    }

    // Pull lines with dimensions
    const lines = await tx
      .select({
        id: glLines.id,
        accountId: glLines.accountId,
        debit: glLines.debit,
        credit: glLines.credit,
        memo: glLines.memo,
        reference: glLines.reference,
        jobId: glLines.jobId,
        costCodeId: glLines.costCodeId,
        customerId: glLines.customerId,
        vendorId: glLines.vendorId,
        employeeId: glLines.employeeId,
        fixedAssetId: glLines.fixedAssetId,
        bankAccountId: glLines.bankAccountId,
      })
      .from(glLines)
      .where(eq(glLines.journalId, originalId));

    const lineDims = await tx
      .select({
        lineId: glLineDimensions.lineId,
        dimensionId: glLineDimensions.dimensionId,
        valueId: glLineDimensions.valueId,
      })
      .from(glLineDimensions)
      .where(
        sql`${glLineDimensions.lineId} = ANY(${sql.raw(
          `ARRAY[${lines.map((l) => `'${l.id}'::uuid`).join(",")}]`
        )})`
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

    // We need a source_code_id for the reversing entry. Look up the 'REV'
    // source code for the org.
    const [revSource] = await tx
      .select({ id: sql<string>`id` })
      .from(sql`source_codes`)
      .where(
        sql`organization_id = ${opts.organizationId} AND code = 'REV'`
      );
    if (!revSource) {
      return {
        ok: false,
        code: "rev_source_missing",
        error:
          "REV source code not found for this organization. Re-run org seeding.",
      };
    }

    const journalDate = opts.reversalDate ?? new Date().toISOString().slice(0, 10);

    const reversalLines: JournalLineInput[] = lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit, // swap
      credit: l.debit, // swap
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

    const draft = await createDraftJournal(tx, {
      organizationId: opts.organizationId,
      actorId: opts.actorId,
      journalDate,
      sourceCodeId: revSource.id,
      source: "reversing",
      description: opts.description ?? `Reversal of ${orig.number}`,
      reasonCodeId: opts.reasonCodeId,
      currency: orig.currency,
      exchangeRate: orig.exchangeRate,
      lines: reversalLines,
      reversesJournalId: originalId,
      numberSeriesCode: "REV",
    });

    return postDraft(tx, {
      journalId: draft.journalId,
      journalNumber: draft.journalNumber,
      actorId: opts.actorId,
      organizationId: opts.organizationId,
      overridePassword: opts.overridePassword,
      overrideReason: opts.overrideReason,
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSeriesForSource(source: NewGlJournal["source"]): string {
  switch (source) {
    case "reversing":
      return "REV";
    default:
      return "JE";
  }
}
