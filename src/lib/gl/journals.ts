import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  dimensionValues,
  dimensions,
  glJournals,
  glLineDimensions,
  glLines,
  journalSource,
  journalStatus,
  type GlJournal,
} from "@/lib/db/schema";
import {
  auditFields,
  requirePermission,
  requirePostingWithinLimit,
  type Ctx,
} from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { money, sumMoney } from "@/lib/money";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import {
  amount,
  currency,
  id,
  isoDate,
  likePattern,
  optionalText,
  pagination,
  toPage,
  type Page,
} from "@/lib/schemas";
import { sourceCodeId as lookupSourceCode } from "./lookups";
import { createDraftJournal, postDraft, reverseJournal } from "./posting";

/**
 * JOURNAL ENTRIES — the general ledger, as a service. Manual entries can be
 * created as drafts (agents without the post scope stop here and a human
 * posts from the review queue) or created-and-posted in one call. Posted
 * entries are immutable; corrections are reversals.
 *
 * Subledger journals (AP, AR, cash) are created by their own services and
 * show up here read-only.
 */

const DimensionTagSchema = z.object({
  dimensionId: id,
  valueId: id,
});

const JournalLineSchema = z
  .object({
    accountId: id,
    debit: amount.optional().describe("Debit amount. Provide debit OR credit, not both."),
    credit: amount.optional().describe("Credit amount. Provide debit OR credit, not both."),
    memo: optionalText(500),
    customerId: id.optional().describe("Optional customer tag for reporting."),
    vendorId: id.optional().describe("Optional vendor tag for reporting."),
    dimensions: z
      .array(DimensionTagSchema)
      .optional()
      .describe("Class / Location / Department / Project tags."),
  })
  .refine(
    (l) => {
      const d = money(l.debit ?? "0");
      const c = money(l.credit ?? "0");
      return (d.gt(0) && c.isZero()) || (c.gt(0) && d.isZero());
    },
    { message: "Each line needs a positive debit or a positive credit, not both." }
  );

/** Posting into a hard-closed period: people only, with the closing password. */
const closedPeriodOverride = {
  closingPassword: z
    .string()
    .max(200)
    .optional()
    .describe("People only: the closing password, to post into a hard-closed period."),
  overrideReason: optionalText(500).describe("Why this posts into a hard-closed period."),
};

export const CreateJournalEntrySchema = z.object({
  date: isoDate.describe("Posting date; must fall in an open fiscal period."),
  description: z.string().trim().min(1).max(500),
  lines: z.array(JournalLineSchema).min(2, "A journal entry needs at least 2 lines."),
  reasonCodeId: id.optional(),
  sourceCodeId: id.optional().describe("Defaults to GJ (General Journal)."),
  currency: currency.optional(),
  exchangeRate: amount.optional(),
  documentNo: optionalText(100),
  autoReverseDate: isoDate
    .optional()
    .describe("For accruals: post an automatic reversal on this date."),
  post: z
    .boolean()
    .optional()
    .describe("Post immediately. Without this the entry is saved as a draft for review."),
  adjusting: z
    .boolean()
    .optional()
    .describe("An adjusting entry: the only kind (with reversals) that posts into a soft-closed period."),
  ...closedPeriodOverride,
});
export type CreateJournalEntryInput = z.input<typeof CreateJournalEntrySchema>;

export const PostJournalEntrySchema = z.object({ id, ...closedPeriodOverride });

export const ListJournalsSchema = z.object({
  status: z.enum(journalStatus.enumValues).optional(),
  source: z.enum(journalSource.enumValues).optional(),
  from: isoDate.optional().describe("Earliest journal date (inclusive)."),
  to: isoDate.optional().describe("Latest journal date (inclusive)."),
  q: z.string().trim().optional().describe("Search number, document #, or description."),
  ...pagination,
});

const IdSchema = z.object({ id });
export const ReverseJournalSchema = z.object({
  id,
  date: isoDate.optional().describe("Reversal date. Defaults to today."),
  description: optionalText(500),
});

export type JournalRow = GlJournal & { totalDebit: string };
export type JournalDetail = GlJournal & {
  totalDebit: string;
  lines: Array<{
    id: string;
    lineNumber: number;
    accountId: string;
    accountCode: string;
    accountName: string;
    debit: string;
    credit: string;
    debitLocal: string;
    creditLocal: string;
    memo: string | null;
    customerId: string | null;
    vendorId: string | null;
    dimensions: Array<{ dimension: string; value: string }>;
  }>;
};

// Literal "gl_journals"."id": Drizzle leaves columns unqualified in
// single-table selects, which would bind `id` to gl_lines inside here.
const totalDebit = sql<string>`COALESCE((SELECT SUM(debit_local) FROM ${glLines} WHERE journal_id = "gl_journals"."id"), 0)::text`;

export async function listJournals(
  ctx: Ctx,
  input: z.input<typeof ListJournalsSchema>
): Promise<Page<JournalRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list journal entries");
  const f = ListJournalsSchema.parse(input);
  const rows = await ctx.tx
    .select({ journal: glJournals, totalDebit })
    .from(glJournals)
    .where(
      and(
        eq(glJournals.organizationId, ctx.actor.organizationId),
        isNull(glJournals.deletedAt),
        f.status ? eq(glJournals.status, f.status) : undefined,
        f.source ? eq(glJournals.source, f.source) : undefined,
        f.from ? gte(glJournals.journalDate, f.from) : undefined,
        f.to ? lte(glJournals.journalDate, f.to) : undefined,
        f.q
          ? or(
              ilike(glJournals.journalNumber, likePattern(f.q)),
              ilike(glJournals.documentNo, likePattern(f.q)),
              ilike(glJournals.description, likePattern(f.q))
            )
          : undefined
      )
    )
    .orderBy(desc(glJournals.journalDate), desc(glJournals.createdAt))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.journal, totalDebit: r.totalDebit })),
    f.limit,
    f.offset
  );
}

export async function getJournal(ctx: Ctx, input: { id: string }): Promise<JournalDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view journal entries");
  const { id: journalId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select({ journal: glJournals, totalDebit })
    .from(glJournals)
    .where(
      and(
        eq(glJournals.id, journalId),
        eq(glJournals.organizationId, ctx.actor.organizationId)
      )
    );
  if (!row) throw notFound("Journal entry");

  const lines = await ctx.tx
    .select({
      id: glLines.id,
      lineNumber: glLines.lineNumber,
      accountId: glLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      debit: glLines.debit,
      credit: glLines.credit,
      debitLocal: glLines.debitLocal,
      creditLocal: glLines.creditLocal,
      memo: glLines.memo,
      customerId: glLines.customerId,
      vendorId: glLines.vendorId,
    })
    .from(glLines)
    .innerJoin(accounts, eq(accounts.id, glLines.accountId))
    .where(eq(glLines.journalId, journalId))
    .orderBy(asc(glLines.lineNumber));

  const dims = await ctx.tx
    .select({
      lineId: glLineDimensions.lineId,
      dimension: dimensions.name,
      value: dimensionValues.name,
    })
    .from(glLineDimensions)
    .innerJoin(glLines, eq(glLines.id, glLineDimensions.lineId))
    .innerJoin(dimensions, eq(dimensions.id, glLineDimensions.dimensionId))
    .innerJoin(dimensionValues, eq(dimensionValues.id, glLineDimensions.valueId))
    .where(eq(glLines.journalId, journalId));

  return {
    ...row.journal,
    totalDebit: row.totalDebit,
    lines: lines.map((l) => ({
      ...l,
      dimensions: dims
        .filter((d) => d.lineId === l.id)
        .map((d) => ({ dimension: d.dimension, value: d.value })),
    })),
  };
}

/** Post a draft inside ctx.tx; validation failures become AppErrors. */
async function postJournalDraft(
  ctx: Ctx,
  journalId: string,
  label: string,
  override: { closingPassword?: string; overrideReason?: string | null } = {}
) {
  const [{ total }] = await ctx.tx
    .select({ total: sql<string>`COALESCE(SUM(${glLines.debitLocal}), 0)::text` })
    .from(glLines)
    .where(eq(glLines.journalId, journalId));
  requirePostingWithinLimit(ctx.actor, total, label);
  if (override.closingPassword && ctx.actor.kind !== "user") {
    throw new AppError("forbidden", "Only a person can post into a hard-closed period.");
  }

  const result = await postDraft(ctx.tx, {
    journalId,
    actorId: ctx.actor.userId,
    actor: ctx.actor,
    organizationId: ctx.actor.organizationId,
    overridePassword: override.closingPassword,
    overrideReason: override.overrideReason ?? undefined,
  });
  if (!result.ok) {
    throw new AppError("posting_failed", result.error, {
      postingCode: result.code,
      ...result.meta,
    });
  }
}

export async function createJournalEntry(
  ctx: Ctx,
  input: CreateJournalEntryInput
): Promise<JournalDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "accountant", "create journal entries");
  const data = CreateJournalEntrySchema.parse(input);
  const org = ctx.actor.organizationId;

  const debits = sumMoney(data.lines.map((l) => l.debit ?? "0"));
  const credits = sumMoney(data.lines.map((l) => l.credit ?? "0"));
  if (!debits.eq(credits)) {
    throw new AppError(
      "invalid_input",
      `Debits (${debits.toFixed(2)}) must equal credits (${credits.toFixed(2)}).`
    );
  }

  const draft = await createDraftJournal(ctx.tx, {
    organizationId: org,
    actorId: ctx.actor.userId,
    actor: ctx.actor,
    journalDate: data.date,
    sourceCodeId: data.sourceCodeId ?? (await lookupSourceCode(ctx.tx, org, "GJ")),
    source: data.adjusting ? "adjusting" : "manual",
    description: data.description,
    reasonCodeId: data.reasonCodeId,
    currency: data.currency,
    exchangeRate: data.exchangeRate,
    documentNo: data.documentNo ?? undefined,
    autoReverseDate: data.autoReverseDate,
    lines: data.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? undefined,
      customerId: l.customerId,
      vendorId: l.vendorId,
      dimensions: l.dimensions,
    })),
  });

  if (data.post) {
    return postOrQueueForReview(
      ctx,
      async (c) => {
        requirePermission(c.actor, "post", "accountant", "post journal entries");
        await postJournalDraft(c, draft.journalId, `Journal entry ${draft.journalNumber}`, data);
        return getJournal(c, { id: draft.journalId });
      },
      () => getJournal(ctx, { id: draft.journalId })
    );
  } else {
    await writeAudit(
      {
        organizationId: org,
        ...auditFields(ctx.actor),
        event: "gl.journal.drafted",
        entityType: "gl_journal",
        entityId: draft.journalId,
        metadata: { journalNumber: draft.journalNumber, total: debits.toFixed(4) },
      },
      ctx.tx
    );
  }
  return getJournal(ctx, { id: draft.journalId });
}

export async function postJournalEntry(ctx: Ctx, input: z.input<typeof PostJournalEntrySchema>): Promise<JournalDetail> {
  requirePermission(ctx.actor, "post", "accountant", "post journal entries");
  const data = PostJournalEntrySchema.parse(input);
  const journalId = data.id;
  const journal = await getJournal(ctx, { id: journalId });
  if (journal.status !== "draft" && journal.status !== "pending_approval") {
    throw invalidState(`Journal ${journal.journalNumber} is ${journal.status}, not a draft.`);
  }
  if (journal.source !== "manual" && journal.source !== "adjusting") {
    throw invalidState(
      `Journal ${journal.journalNumber} belongs to the ${journal.source} subledger; post it from its source document.`
    );
  }
  await postJournalDraft(ctx, journalId, `Journal entry ${journal.journalNumber}`, data);
  return getJournal(ctx, { id: journalId });
}

export async function reverseJournalEntry(
  ctx: Ctx,
  input: z.input<typeof ReverseJournalSchema>
): Promise<JournalDetail> {
  requirePermission(ctx.actor, "post", "accountant", "reverse journal entries");
  const data = ReverseJournalSchema.parse(input);
  const journal = await getJournal(ctx, { id: data.id });
  if (journal.source !== "manual" && journal.source !== "recurring" && journal.source !== "adjusting") {
    throw invalidState(
      `Journal ${journal.journalNumber} came from the ${journal.source} subledger; void the source document instead so the subledger stays in sync.`
    );
  }
  const result = await reverseJournal(
    data.id,
    {
      actorId: ctx.actor.userId,
      actor: ctx.actor,
      organizationId: ctx.actor.organizationId,
      reversalDate: data.date,
      description: data.description ?? undefined,
    },
    ctx.tx
  );
  if (!result.ok) {
    throw new AppError("posting_failed", result.error, { postingCode: result.code });
  }
  return getJournal(ctx, { id: result.journalId });
}

/** Discard a draft manual entry. Posted entries can only be reversed. */
export async function deleteDraftJournal(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "accountant", "delete draft journal entries");
  const { id: journalId } = IdSchema.parse(input);
  const journal = await getJournal(ctx, { id: journalId });
  if (journal.status !== "draft") {
    throw invalidState(`Only drafts can be deleted; ${journal.journalNumber} is ${journal.status}.`);
  }
  if (journal.source !== "manual" && journal.source !== "adjusting") {
    throw invalidState(`Journal ${journal.journalNumber} belongs to the ${journal.source} subledger.`);
  }
  await ctx.tx.delete(glJournals).where(eq(glJournals.id, journalId));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "gl.journal.draft_deleted",
      entityType: "gl_journal",
      entityId: journalId,
      metadata: { journalNumber: journal.journalNumber },
    },
    ctx.tx
  );
  return { id: journalId };
}
