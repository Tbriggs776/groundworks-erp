import { addDays, format, parseISO } from "date-fns";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bankStatementImports,
  bankStatementLines,
  bankStatementMatches,
  bankTransactions,
  glJournals,
  glLineClearings,
  glLines,
  statementLineStatus,
  type BankRule,
  type BankStatementLine,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound, toAppError } from "@/lib/errors";
import { inLedger } from "@/lib/gl/ledger";
import { money, sumMoney } from "@/lib/money";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import { id, isoDate, optionalText, pagination, toPage, type Page } from "@/lib/schemas";
import { DimensionTagSchema, lineAmount, requireBankingAccount } from "./common";
import { clearLedgerLines } from "./matching";
import { parseStatement, type ParsedLine } from "./parse";
import { activeRules, firstMatchingRule } from "./rules";
import {
  createDeposit,
  createExpense,
  createTransfer,
  deleteDraftBankTransaction,
  getBankTransaction,
  postBankTransaction,
  voidBankTransaction,
  type BankTransactionDetail,
} from "./transactions";

/**
 * STATEMENT IMPORT + "FOR REVIEW". Lines come in from a file; each is then
 * matched to what's already in the books, added as a new transaction
 * (categorized by hand or by a rule), or excluded. Every step is audited
 * and can be undone.
 */

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const ImportStatementSchema = z.object({
  accountId: id.describe("Reconcilable bank or credit card account the statement belongs to."),
  content: z.string().min(1).max(5_000_000).describe("The file's text: CSV, OFX, or QFX (detected automatically)."),
  fileName: optionalText(200),
  dateFormat: z
    .enum(["MDY", "DMY", "YMD"])
    .optional()
    .describe("CSV date order. Default: guessed (US month-first unless a day over 12 shows otherwise)."),
  flipSigns: z
    .boolean()
    .optional()
    .describe("The file shows charges / withdrawals as positive numbers (common for credit card CSVs). Flip them."),
  applyRules: z.boolean().optional().describe("Run bank rules on the new lines. Default true."),
});
export type ImportStatementInput = z.input<typeof ImportStatementSchema>;

export type ImportResult = {
  importId: string;
  format: "csv" | "ofx";
  lineCount: number;
  newCount: number;
  duplicateCount: number;
  skipped: Array<{ row: number; reason: string }>;
  ledgerBalance: string | null;
  rules: RuleRunResult;
};

export async function importStatement(ctx: Ctx, input: ImportStatementInput): Promise<ImportResult> {
  requirePermission(ctx.actor, "write", "bookkeeper", "import bank statements");
  const d = ImportStatementSchema.parse(input);
  const account = await requireBankingAccount(ctx.tx, ctx.actor.organizationId, d.accountId, { reconcilable: true });

  let parsed;
  try {
    parsed = parseStatement(d.content, { dateFormat: d.dateFormat, flipSigns: d.flipSigns });
  } catch (e) {
    throw new AppError("invalid_input", (e as Error).message);
  }
  if (parsed.lines.length === 0) {
    throw new AppError("invalid_input", "No transactions found in the file.", { skipped: parsed.skipped });
  }
  const r = await ingestLines(ctx, {
    accountId: account.id,
    format: parsed.format,
    fileName: d.fileName ?? null,
    lines: parsed.lines,
    ledgerBalance: parsed.ledgerBalance,
    ledgerBalanceDate: parsed.ledgerBalanceDate,
    applyRules: d.applyRules !== false,
    audit: { skipped: parsed.skipped.length },
  });
  return { ...r, format: parsed.format, skipped: parsed.skipped, ledgerBalance: parsed.ledgerBalance };
}

/**
 * Put statement lines into For review: a statement file's, or a bank
 * feed's. A line whose fit id the account already has is a duplicate and
 * skipped. Rules run over the new lines.
 */
export async function ingestLines(
  ctx: Ctx,
  opts: {
    accountId: string;
    format: "csv" | "ofx" | "feed";
    fileName: string | null;
    lines: ParsedLine[];
    ledgerBalance?: string | null;
    ledgerBalanceDate?: string | null;
    applyRules: boolean;
    audit?: Record<string, unknown>;
  }
): Promise<Pick<ImportResult, "importId" | "lineCount" | "newCount" | "duplicateCount" | "rules">> {
  const org = ctx.actor.organizationId;
  const dates = opts.lines.map((l) => l.postedDate).sort();
  const [imp] = await ctx.tx
    .insert(bankStatementImports)
    .values({
      organizationId: org,
      accountId: opts.accountId,
      fileName: opts.fileName,
      format: opts.format,
      lineCount: opts.lines.length,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      ledgerBalance: opts.ledgerBalance ?? null,
      ledgerBalanceDate: opts.ledgerBalanceDate ?? null,
      importedBy: ctx.actor.userId,
      importedByAgentId: ctx.actor.agentId,
    })
    .returning();
  const inserted = await ctx.tx
    .insert(bankStatementLines)
    .values(opts.lines.map((l) => ({ ...l, organizationId: org, accountId: opts.accountId, importId: imp.id })))
    .onConflictDoNothing({ target: [bankStatementLines.accountId, bankStatementLines.fitId] })
    .returning({ id: bankStatementLines.id });
  const newCount = inserted.length;
  await ctx.tx
    .update(bankStatementImports)
    .set({ newCount, duplicateCount: opts.lines.length - newCount })
    .where(eq(bankStatementImports.id, imp.id));
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "bank.statement.imported",
      entityType: "bank_statement_import",
      entityId: imp.id,
      metadata: {
        accountId: opts.accountId,
        fileName: opts.fileName,
        format: opts.format,
        lines: opts.lines.length,
        new: newCount,
        duplicates: opts.lines.length - newCount,
        ...opts.audit,
      },
    },
    ctx.tx
  );
  const rules =
    !opts.applyRules || newCount === 0
      ? { categorized: 0, autoAdded: 0, autoAddHeld: 0, errors: [] }
      : await runRules(ctx, inserted.map((r) => r.id));
  return { importId: imp.id, lineCount: opts.lines.length, newCount, duplicateCount: opts.lines.length - newCount, rules };
}

// ---------------------------------------------------------------------------
// For review
// ---------------------------------------------------------------------------

export const ListStatementLinesSchema = z.object({
  accountId: id,
  status: z.enum(statementLineStatus.enumValues).optional().describe("Default for_review."),
  ...pagination,
});

export type MatchCandidate = {
  glLineId: string;
  journalId: string;
  journalNumber: string;
  date: string;
  description: string;
  amount: string;
};

export type StatementLineRow = BankStatementLine & {
  /** Ledger lines with the same amount near the date, best first. */
  suggestedMatches: MatchCandidate[];
  /** The rule that would categorize it, when nothing matches. */
  suggestedRule: { id: string; name: string; autoAdd: boolean } | null;
};

/** Unmatched, unreconciled ledger lines on an account in a date window. */
async function ledgerCandidates(ctx: Ctx, accountId: string, from: string, to: string): Promise<MatchCandidate[]> {
  const rows = await ctx.tx
    .select({
      glLineId: glLines.id,
      journalId: glJournals.id,
      journalNumber: glJournals.journalNumber,
      date: glJournals.journalDate,
      description: sql<string>`coalesce(${glLines.memo}, ${glJournals.description})`,
      amount: lineAmount,
    })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .where(
      and(
        eq(glLines.organizationId, ctx.actor.organizationId),
        eq(glLines.accountId, accountId),
        inLedger(),
        gte(glJournals.journalDate, from),
        lte(glJournals.journalDate, to),
        sql`NOT EXISTS (SELECT 1 FROM bank_statement_matches m WHERE m.gl_line_id = "gl_lines"."id")`,
        sql`NOT EXISTS (SELECT 1 FROM gl_line_clearings c WHERE c.gl_line_id = "gl_lines"."id" AND c.status = 'reconciled')`
      )
    )
    .orderBy(asc(glJournals.journalDate));
  return rows.map((r) => ({ ...r, amount: money(r.amount).toFixed(4) }));
}

const day = (d: string, n: number) => format(addDays(parseISO(d), n), "yyyy-MM-dd");
const daysApart = (a: string, b: string) => Math.abs(parseISO(a).getTime() - parseISO(b).getTime()) / 86_400_000;

export async function listStatementLines(
  ctx: Ctx,
  input: z.input<typeof ListStatementLinesSchema>
): Promise<Page<StatementLineRow>> {
  requirePermission(ctx.actor, "read", "viewer", "review bank statement lines");
  const f = ListStatementLinesSchema.parse(input);
  const status = f.status ?? "for_review";
  const rows = await ctx.tx
    .select()
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.organizationId, ctx.actor.organizationId),
        eq(bankStatementLines.accountId, f.accountId),
        eq(bankStatementLines.status, status),
        isNull(bankStatementLines.deletedAt)
      )
    )
    .orderBy(desc(bankStatementLines.postedDate), asc(bankStatementLines.description))
    .limit(f.limit + 1)
    .offset(f.offset);
  const page = toPage(rows, f.limit, f.offset);
  if (status !== "for_review" || page.data.length === 0) {
    return { ...page, data: page.data.map((l) => ({ ...l, suggestedMatches: [], suggestedRule: null })) };
  }
  const dates = page.data.map((l) => l.postedDate).sort();
  const candidates = await ledgerCandidates(ctx, f.accountId, day(dates[0], -10), day(dates[dates.length - 1], 10));
  const rules = await activeRules(ctx, f.accountId);
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const used = new Set<string>();
  return {
    ...page,
    data: page.data.map((l) => {
      const matches = candidates
        .filter((c) => !used.has(c.glLineId) && money(c.amount).eq(money(l.amount)) && daysApart(c.date, l.postedDate) <= 10)
        .sort((a, b) => daysApart(a.date, l.postedDate) - daysApart(b.date, l.postedDate))
        .slice(0, 3);
      if (matches[0]) used.add(matches[0].glLineId);
      const rule = (l.ruleId && ruleById.get(l.ruleId)) || firstMatchingRule(rules, l);
      return {
        ...l,
        suggestedMatches: matches,
        suggestedRule: rule ? { id: rule.id, name: rule.name, autoAdd: rule.autoAdd } : null,
      };
    }),
  };
}

export const FindMatchesSchema = z.object({
  id: id.describe("Statement line id."),
  from: isoDate.optional().describe("Default: 45 days before the line."),
  to: isoDate.optional().describe("Default: 15 days after the line."),
});

/** Every unmatched ledger line on the account near the date, for matching by hand (several can add up to one line). */
export async function findMatchCandidates(ctx: Ctx, input: z.input<typeof FindMatchesSchema>): Promise<MatchCandidate[]> {
  requirePermission(ctx.actor, "read", "viewer", "find matches for a bank line");
  const d = FindMatchesSchema.parse(input);
  const line = await loadLine(ctx, d.id);
  return ledgerCandidates(ctx, line.accountId, d.from ?? day(line.postedDate, -45), d.to ?? day(line.postedDate, 15));
}

async function loadLine(ctx: Ctx, lineId: string, lock = false): Promise<BankStatementLine> {
  const q = ctx.tx
    .select()
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.organizationId, ctx.actor.organizationId)));
  const [line] = lock ? await q.for("update") : await q;
  if (!line) throw notFound("Statement line");
  return line;
}

async function markReviewed(ctx: Ctx, lineId: string, set: Partial<typeof bankStatementLines.$inferInsert>) {
  await ctx.tx
    .update(bankStatementLines)
    .set({
      ...set,
      reviewedBy: ctx.actor.userId,
      reviewedByAgentId: ctx.actor.agentId,
      reviewedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(bankStatementLines.id, lineId));
}

async function audit(ctx: Ctx, event: string, line: BankStatementLine, metadata: Record<string, unknown> = {}) {
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event,
      entityType: "bank_statement_line",
      entityId: line.id,
      metadata: { accountId: line.accountId, date: line.postedDate, amount: line.amount, description: line.description, ...metadata },
    },
    ctx.tx
  );
}

export const MatchStatementLineSchema = z.object({
  id: id.describe("Statement line id."),
  glLineIds: z
    .array(id)
    .min(1)
    .max(50)
    .describe("Ledger lines on the same account (from suggestedMatches or find_bank_line_matches). Their amounts must add up to the statement line."),
});

export async function matchStatementLine(ctx: Ctx, input: z.input<typeof MatchStatementLineSchema>): Promise<StatementLineRow> {
  requirePermission(ctx.actor, "write", "bookkeeper", "match bank lines");
  const d = MatchStatementLineSchema.parse(input);
  const line = await loadLine(ctx, d.id, true);
  if (line.status !== "for_review") throw invalidState(`This line is already ${line.status.replace("_", " ")}.`);
  if (new Set(d.glLineIds).size !== d.glLineIds.length) throw new AppError("invalid_input", "A ledger line is listed twice.");
  const rows = await ctx.tx
    .select({ id: glLines.id, accountId: glLines.accountId, amount: lineAmount })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .where(and(eq(glLines.organizationId, ctx.actor.organizationId), inArray(glLines.id, d.glLineIds), inLedger()));
  if (rows.length !== d.glLineIds.length) throw notFound("One or more ledger lines");
  if (rows.some((r) => r.accountId !== line.accountId)) {
    throw new AppError("invalid_input", "Every matched ledger line must be on the same account as the statement line.");
  }
  const taken = await ctx.tx
    .select({ id: bankStatementMatches.glLineId })
    .from(bankStatementMatches)
    .where(inArray(bankStatementMatches.glLineId, d.glLineIds));
  if (taken.length > 0) throw invalidState("A ledger line is already matched to another statement line.");
  const reconciled = await ctx.tx
    .select({ id: glLineClearings.glLineId })
    .from(glLineClearings)
    .where(and(inArray(glLineClearings.glLineId, d.glLineIds), eq(glLineClearings.status, "reconciled")));
  if (reconciled.length > 0) throw invalidState("A ledger line is already reconciled.");
  const total = sumMoney(rows.map((r) => r.amount));
  if (!total.eq(money(line.amount))) {
    throw new AppError(
      "invalid_input",
      `The ledger lines add up to ${total.toFixed(2)}; the statement line is ${money(line.amount).toFixed(2)}.`,
      { ledgerTotal: total.toFixed(2), statementAmount: money(line.amount).toFixed(2) }
    );
  }
  await ctx.tx
    .insert(bankStatementMatches)
    .values(d.glLineIds.map((glLineId) => ({ organizationId: ctx.actor.organizationId, statementLineId: line.id, glLineId })));
  await clearLedgerLines(ctx, line.accountId, d.glLineIds);
  await markReviewed(ctx, line.id, { status: "matched" });
  await audit(ctx, "bank.line.matched", line, { glLineIds: d.glLineIds });
  return { ...(await loadLine(ctx, line.id)), suggestedMatches: [], suggestedRule: null };
}

export const AddStatementLineSchema = z.object({
  id: id.describe("Statement line id."),
  categoryAccountId: id.optional().describe("Category account for a new expense (money out) or deposit (money in)."),
  transferAccountId: id.optional().describe("Or: the other bank / card account, to record a transfer (e.g. a card payment)."),
  vendorId: id.optional(),
  customerId: id.optional(),
  payeeName: optionalText(200),
  memo: optionalText(500),
  dimensions: z.array(DimensionTagSchema).optional(),
});
export type AddStatementLineInput = z.input<typeof AddStatementLineSchema>;

/**
 * Record a statement line as a new bank transaction and post it (agents
 * without the post scope, or over their limit, leave a draft for review).
 * With no category or transfer given, the line's rule decides.
 */
export async function addStatementLine(
  ctx: Ctx,
  input: AddStatementLineInput
): Promise<{ line: BankStatementLine; transaction: BankTransactionDetail } & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "add bank lines to the books");
  const d = AddStatementLineSchema.parse(input);
  const line = await loadLine(ctx, d.id, true);
  if (line.status !== "for_review") throw invalidState(`This line is already ${line.status.replace("_", " ")}.`);
  let rule: BankRule | null = null;
  if (!d.categoryAccountId && !d.transferAccountId) {
    rule = line.ruleId ? (await activeRules(ctx)).find((r) => r.id === line.ruleId) ?? null : null;
    rule ??= firstMatchingRule(await activeRules(ctx, line.accountId), line);
    if (!rule) {
      throw new AppError("invalid_input", "Pick a categoryAccountId or a transferAccountId (no bank rule matches this line).");
    }
  }
  const txn = await createFromLine(ctx, line, {
    categoryAccountId: d.categoryAccountId ?? (d.transferAccountId ? undefined : rule?.categoryAccountId ?? undefined),
    transferAccountId: d.transferAccountId ?? (d.categoryAccountId ? undefined : rule?.transferAccountId ?? undefined),
    vendorId: d.vendorId ?? rule?.vendorId ?? undefined,
    customerId: d.customerId ?? rule?.customerId ?? undefined,
    payeeName: d.payeeName ?? rule?.payeeName ?? undefined,
    memo: d.memo ?? rule?.memo ?? undefined,
    dimensions: d.dimensions ?? rule?.dimensions ?? [],
  });
  await markReviewed(ctx, line.id, { status: "added", bankTransactionId: txn.id, ruleId: rule?.id ?? line.ruleId });
  await audit(ctx, "bank.line.added", line, { bankTransactionId: txn.id, ruleId: rule?.id ?? null });
  const posted = await postOrQueueForReview(
    ctx,
    (c) => postBankTransaction(c, { id: txn.id }),
    () => getBankTransaction(ctx, { id: txn.id })
  );
  const { review, ...transaction } = posted;
  return { line: await loadLine(ctx, line.id), transaction, ...(review ? { review } : {}) };
}

async function createFromLine(
  ctx: Ctx,
  line: BankStatementLine,
  a: {
    categoryAccountId?: string;
    transferAccountId?: string;
    vendorId?: string;
    customerId?: string;
    payeeName?: string;
    memo?: string;
    dimensions: Array<{ dimensionId: string; valueId: string }>;
  }
) {
  const amt = money(line.amount);
  const abs = amt.abs().toFixed(4);
  const memo = a.memo ?? line.description;
  if (a.transferAccountId) {
    return createTransfer(ctx, {
      txnDate: line.postedDate,
      fromAccountId: amt.lt(0) ? line.accountId : a.transferAccountId,
      toAccountId: amt.lt(0) ? a.transferAccountId : line.accountId,
      amount: abs,
      reference: line.reference ?? undefined,
      memo,
    });
  }
  if (!a.categoryAccountId) throw new AppError("invalid_input", "Pick a categoryAccountId or a transferAccountId.");
  const payee = {
    vendorId: a.vendorId,
    customerId: a.vendorId ? undefined : a.customerId,
    payeeName: a.payeeName ?? (a.vendorId || a.customerId ? undefined : line.payee ?? undefined),
  };
  const lines = [{ accountId: a.categoryAccountId, amount: abs, description: line.description, dimensions: a.dimensions }];
  if (amt.lt(0)) {
    return createExpense(ctx, {
      type: line.reference && /^\d+$/.test(line.reference) ? "check" : "expense",
      txnDate: line.postedDate,
      bankAccountId: line.accountId,
      ...payee,
      reference: line.reference ?? undefined,
      memo,
      lines,
    });
  }
  return createDeposit(ctx, { txnDate: line.postedDate, bankAccountId: line.accountId, ...payee, reference: line.reference ?? undefined, memo, lines });
}

export async function excludeStatementLine(ctx: Ctx, input: { id: string }): Promise<BankStatementLine> {
  requirePermission(ctx.actor, "write", "bookkeeper", "exclude bank lines");
  const { id: lineId } = z.object({ id }).parse(input);
  const line = await loadLine(ctx, lineId, true);
  if (line.status !== "for_review") throw invalidState(`This line is already ${line.status.replace("_", " ")}.`);
  await markReviewed(ctx, line.id, { status: "excluded" });
  await audit(ctx, "bank.line.excluded", line);
  return loadLine(ctx, line.id);
}

/**
 * Put a line back in For review. Matched: unmatch and unclear. Added: a
 * draft transaction is deleted, a posted one voided (admins only, like any
 * void). Excluded: just restored. Reconciled lines can't be undone.
 */
export async function undoStatementLine(ctx: Ctx, input: { id: string }): Promise<BankStatementLine> {
  requirePermission(ctx.actor, "write", "bookkeeper", "undo bank line reviews");
  const { id: lineId } = z.object({ id }).parse(input);
  const line = await loadLine(ctx, lineId, true);
  if (line.status === "for_review") throw invalidState("This line is already in For review.");
  const matched = await ctx.tx
    .select({ glLineId: bankStatementMatches.glLineId })
    .from(bankStatementMatches)
    .where(eq(bankStatementMatches.statementLineId, line.id));
  const glLineIds = matched.map((m) => m.glLineId);
  if (glLineIds.length > 0) {
    const reconciled = await ctx.tx
      .select({ id: glLineClearings.glLineId })
      .from(glLineClearings)
      .where(and(inArray(glLineClearings.glLineId, glLineIds), eq(glLineClearings.status, "reconciled")));
    if (reconciled.length > 0) throw invalidState("This line is part of a completed reconciliation. Undo the reconciliation first.");
    await ctx.tx.delete(bankStatementMatches).where(eq(bankStatementMatches.statementLineId, line.id));
    await ctx.tx.delete(glLineClearings).where(inArray(glLineClearings.glLineId, glLineIds));
  }
  if (line.status === "added" && line.bankTransactionId) {
    const [txn] = await ctx.tx
      .select({ status: bankTransactions.status })
      .from(bankTransactions)
      .where(eq(bankTransactions.id, line.bankTransactionId));
    if (txn?.status === "draft") await deleteDraftBankTransaction(ctx, { id: line.bankTransactionId });
    else if (txn?.status === "posted") {
      await voidBankTransaction(ctx, { id: line.bankTransactionId, reason: "Undo of bank line review" });
    }
  }
  await ctx.tx
    .update(bankStatementLines)
    .set({ status: "for_review", bankTransactionId: null, ruleId: null, reviewedBy: null, reviewedByAgentId: null, reviewedAt: null, updatedAt: sql`now()` })
    .where(eq(bankStatementLines.id, line.id));
  await audit(ctx, "bank.line.undone", line, { was: line.status });
  return loadLine(ctx, line.id);
}

// ---------------------------------------------------------------------------
// Rules over For review
// ---------------------------------------------------------------------------

export type RuleRunResult = {
  /** Lines a rule now suggests a category for. */
  categorized: number;
  /** Lines recorded automatically by auto-add rules. */
  autoAdded: number;
  /** Auto-add lines left for review (no post permission, over a limit, or an error). */
  autoAddHeld: number;
  errors: Array<{ lineId: string; message: string }>;
};

async function runRules(ctx: Ctx, lineIds: string[] | null, accountId?: string): Promise<RuleRunResult> {
  const lines = await ctx.tx
    .select()
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.organizationId, ctx.actor.organizationId),
        eq(bankStatementLines.status, "for_review"),
        lineIds ? inArray(bankStatementLines.id, lineIds) : undefined,
        accountId ? eq(bankStatementLines.accountId, accountId) : undefined
      )
    );
  const rules = await activeRules(ctx);
  const result: RuleRunResult = { categorized: 0, autoAdded: 0, autoAddHeld: 0, errors: [] };
  for (const line of lines) {
    const rule = firstMatchingRule(rules, line);
    if ((rule?.id ?? null) !== line.ruleId) {
      await ctx.tx.update(bankStatementLines).set({ ruleId: rule?.id ?? null, updatedAt: sql`now()` }).where(eq(bankStatementLines.id, line.id));
    }
    if (!rule) continue;
    result.categorized++;
    if (!rule.autoAdd) continue;
    try {
      // Savepoint per line: one bad line doesn't sink the import.
      const added = await ctx.tx.transaction((sp) => addStatementLine({ actor: ctx.actor, tx: sp }, { id: line.id }));
      if (added.review) result.autoAddHeld++;
      else result.autoAdded++;
    } catch (e) {
      result.autoAddHeld++;
      result.errors.push({ lineId: line.id, message: toAppError(e).message });
    }
  }
  return result;
}

export const ApplyBankRulesSchema = z.object({
  accountId: id.optional().describe("Only this account's lines. Omit for all."),
});

/** Re-run rules over everything in For review (after adding or changing a rule). */
export async function applyBankRules(ctx: Ctx, input: z.input<typeof ApplyBankRulesSchema>): Promise<RuleRunResult> {
  requirePermission(ctx.actor, "write", "bookkeeper", "apply bank rules");
  const d = ApplyBankRulesSchema.parse(input);
  if (d.accountId) await requireBankingAccount(ctx.tx, ctx.actor.organizationId, d.accountId, { reconcilable: true });
  const r = await runRules(ctx, null, d.accountId);
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "bank.rules.applied",
      entityType: "bank_rule",
      metadata: { accountId: d.accountId ?? null, ...r, errors: r.errors.length },
    },
    ctx.tx
  );
  return r;
}

/** For the overview: For-review counts per account. */
export async function forReviewCounts(ctx: Ctx): Promise<Map<string, number>> {
  const rows = await ctx.tx
    .select({ accountId: bankStatementLines.accountId, n: sql<number>`count(*)::int` })
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.organizationId, ctx.actor.organizationId), eq(bankStatementLines.status, "for_review")))
    .groupBy(bankStatementLines.accountId);
  return new Map(rows.map((r) => [r.accountId, r.n]));
}
