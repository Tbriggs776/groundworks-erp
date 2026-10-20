import { and, desc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  bankStatementImports,
  glJournals,
  glLineClearings,
  glLines,
  reconciliations,
  type Account,
  type Reconciliation,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { inLedger } from "@/lib/gl/ledger";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { amount, id, isoDate, pagination, toPage, type Page } from "@/lib/schemas";
import { lineAmount, requireBankingAccount } from "./common";
import { clearLedgerLines } from "./matching";
import { forReviewCounts } from "./review";

/**
 * RECONCILIATION. Tick the ledger lines a statement shows until the
 * cleared balance equals the statement's ending balance, then complete:
 * those lines become reconciled and drop out of future reconciliations.
 *
 * Balances here are in the account's natural sign: what's in the bank for
 * a bank account, what's owed for a credit card. (Ledger amounts are
 * debit − credit; a credit-normal account flips.)
 */

const natural = (a: Pick<Account, "normalBalance">) => (a.normalBalance === "credit" ? -1 : 1);

/** Σ (debit − credit) of ledger lines on the account that pass `where`. */
async function sumLines(ctx: Ctx, accountId: string, where: ReturnType<typeof sql> | undefined) {
  const [row] = await ctx.tx
    .select({ total: sql<string>`coalesce(sum(${lineAmount}), 0)` })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .where(and(eq(glLines.organizationId, ctx.actor.organizationId), eq(glLines.accountId, accountId), inLedger(), where));
  return money(row.total);
}

const isReconciled = sql`EXISTS (SELECT 1 FROM gl_line_clearings c WHERE c.gl_line_id = "gl_lines"."id" AND c.status = 'reconciled')`;
const isClearedOrReconciled = sql`EXISTS (SELECT 1 FROM gl_line_clearings c WHERE c.gl_line_id = "gl_lines"."id")`;

// ---------------------------------------------------------------------------
// Start / worksheet
// ---------------------------------------------------------------------------

export const StartReconciliationSchema = z.object({
  accountId: id.describe("Reconcilable bank or credit card account."),
  statementEndDate: isoDate.describe("The statement's ending date."),
  statementEndingBalance: amount.describe(
    "The statement's ending balance, as printed: money in the account for a bank, amount owed for a credit card."
  ),
});

async function loadRec(ctx: Ctx, recId: string, lock = false): Promise<Reconciliation> {
  const q = ctx.tx
    .select()
    .from(reconciliations)
    .where(and(eq(reconciliations.id, recId), eq(reconciliations.organizationId, ctx.actor.organizationId)));
  const [rec] = lock ? await q.for("update") : await q;
  if (!rec) throw notFound("Reconciliation");
  return rec;
}

export async function startReconciliation(ctx: Ctx, input: z.input<typeof StartReconciliationSchema>): Promise<ReconciliationWorksheet> {
  requirePermission(ctx.actor, "write", "accountant", "reconcile accounts");
  const d = StartReconciliationSchema.parse(input);
  const account = await requireBankingAccount(ctx.tx, ctx.actor.organizationId, d.accountId, { reconcilable: true });
  const [open] = await ctx.tx
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .where(and(eq(reconciliations.accountId, account.id), eq(reconciliations.status, "in_progress")));
  if (open) throw invalidState("A reconciliation of this account is already in progress. Finish or cancel it first.", { reconciliationId: open.id });
  const [last] = await ctx.tx
    .select({ statementEndDate: reconciliations.statementEndDate })
    .from(reconciliations)
    .where(and(eq(reconciliations.accountId, account.id), eq(reconciliations.status, "completed")))
    .orderBy(desc(reconciliations.statementEndDate))
    .limit(1);
  if (last && d.statementEndDate <= last.statementEndDate) {
    throw new AppError("invalid_input", `The last reconciliation ended ${last.statementEndDate}; pick a later statement date.`);
  }
  const beginning = (await sumLines(ctx, account.id, isReconciled)).times(natural(account));
  const [rec] = await ctx.tx
    .insert(reconciliations)
    .values({
      organizationId: ctx.actor.organizationId,
      accountId: account.id,
      statementEndDate: d.statementEndDate,
      statementEndingBalance: d.statementEndingBalance,
      beginningBalance: toDbMoney(beginning),
      startedBy: ctx.actor.userId,
      startedByAgentId: ctx.actor.agentId,
    })
    .returning();
  await audit(ctx, "bank.reconciliation.started", rec);
  return getReconciliation(ctx, { id: rec.id });
}

export type WorksheetLine = {
  glLineId: string;
  journalId: string;
  journalNumber: string;
  date: string;
  description: string;
  payee: string | null;
  /** Natural sign: + deposits / charges add to the balance, − payments take away. */
  amount: string;
  cleared: boolean;
};

export type ReconciliationWorksheet = Reconciliation & {
  accountCode: string;
  accountName: string;
  normalBalance: Account["normalBalance"];
  lines: WorksheetLine[];
  clearedIncrease: string;
  clearedDecrease: string;
  clearedBalance: string;
  difference: string;
};

/** The worksheet: unreconciled lines up to the statement date, what's ticked, and the difference. */
export async function getReconciliation(ctx: Ctx, input: { id: string }): Promise<ReconciliationWorksheet> {
  requirePermission(ctx.actor, "read", "viewer", "view reconciliations");
  const { id: recId } = z.object({ id }).parse(input);
  const rec = await loadRec(ctx, recId);
  const [account] = await ctx.tx.select().from(accounts).where(eq(accounts.id, rec.accountId));
  const sign = natural(account);
  const rows =
    rec.status === "in_progress"
      ? await ctx.tx
          .select({
            glLineId: glLines.id,
            journalId: glJournals.id,
            journalNumber: glJournals.journalNumber,
            date: glJournals.journalDate,
            description: sql<string>`coalesce(${glLines.memo}, ${glJournals.description})`,
            payee: sql<string | null>`(SELECT coalesce(v.name, c.name) FROM gl_lines gl LEFT JOIN vendors v ON v.id = gl.vendor_id LEFT JOIN customers c ON c.id = gl.customer_id WHERE gl.id = "gl_lines"."id")`,
            amount: lineAmount,
            cleared: sql<boolean>`${isClearedOrReconciled}`,
          })
          .from(glLines)
          .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
          .where(
            and(
              eq(glLines.organizationId, ctx.actor.organizationId),
              eq(glLines.accountId, rec.accountId),
              inLedger(),
              lte(glJournals.journalDate, rec.statementEndDate),
              sql`NOT ${isReconciled}`
            )
          )
          .orderBy(glJournals.journalDate, glJournals.journalNumber)
      : [];
  const lines = rows.map((r) => ({ ...r, amount: toDbMoney(money(r.amount).times(sign)) }));
  const cleared = lines.filter((l) => l.cleared).map((l) => money(l.amount));
  const increase = sumMoney(cleared.filter((a) => a.gt(0)));
  const decrease = sumMoney(cleared.filter((a) => a.lt(0))).abs();
  const clearedBalance =
    rec.status === "in_progress" ? money(rec.beginningBalance).plus(increase).minus(decrease) : money(rec.clearedBalance ?? 0);
  return {
    ...rec,
    accountCode: account.code,
    accountName: account.name,
    normalBalance: account.normalBalance,
    lines,
    clearedIncrease: toDbMoney(increase),
    clearedDecrease: toDbMoney(decrease),
    clearedBalance: toDbMoney(clearedBalance),
    difference: toDbMoney(money(rec.statementEndingBalance).minus(clearedBalance)),
  };
}

export const SetClearedSchema = z.object({
  id: id.describe("Reconciliation id."),
  glLineIds: z.array(id).min(1).max(500),
  cleared: z.boolean().describe("true to tick, false to untick."),
});

export async function setCleared(ctx: Ctx, input: z.input<typeof SetClearedSchema>): Promise<ReconciliationWorksheet> {
  requirePermission(ctx.actor, "write", "accountant", "reconcile accounts");
  const d = SetClearedSchema.parse(input);
  const rec = await loadRec(ctx, d.id, true);
  if (rec.status !== "in_progress") throw invalidState(`This reconciliation is ${rec.status.replace("_", " ")}.`);
  const rows = await ctx.tx
    .select({ id: glLines.id, accountId: glLines.accountId, date: glJournals.journalDate, reconciled: sql<boolean>`${isReconciled}` })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .where(and(eq(glLines.organizationId, ctx.actor.organizationId), inArray(glLines.id, d.glLineIds), inLedger()));
  if (rows.length !== new Set(d.glLineIds).size) throw notFound("One or more ledger lines");
  for (const r of rows) {
    if (r.accountId !== rec.accountId) throw new AppError("invalid_input", "A line isn't on the account being reconciled.");
    if (r.date > rec.statementEndDate) throw new AppError("invalid_input", "A line is dated after the statement ending date.");
    if (r.reconciled) throw invalidState("A line is already reconciled.");
  }
  if (d.cleared) {
    await clearLedgerLines(ctx, rec.accountId, d.glLineIds, rec.id);
  } else {
    await ctx.tx
      .delete(glLineClearings)
      .where(and(inArray(glLineClearings.glLineId, d.glLineIds), eq(glLineClearings.status, "cleared")));
  }
  return getReconciliation(ctx, { id: rec.id });
}

export const UpdateReconciliationSchema = z.object({
  id: id.describe("Reconciliation id."),
  statementEndDate: isoDate.optional(),
  statementEndingBalance: amount.optional(),
});

/** Fix a typo in the statement date or balance while the reconciliation is open. */
export async function updateReconciliation(ctx: Ctx, input: z.input<typeof UpdateReconciliationSchema>): Promise<ReconciliationWorksheet> {
  requirePermission(ctx.actor, "write", "accountant", "reconcile accounts");
  const d = UpdateReconciliationSchema.parse(input);
  const rec = await loadRec(ctx, d.id, true);
  if (rec.status !== "in_progress") throw invalidState(`This reconciliation is ${rec.status.replace("_", " ")}.`);
  if (d.statementEndDate && d.statementEndDate !== rec.statementEndDate) {
    const [last] = await ctx.tx
      .select({ statementEndDate: reconciliations.statementEndDate })
      .from(reconciliations)
      .where(and(eq(reconciliations.accountId, rec.accountId), eq(reconciliations.status, "completed")))
      .orderBy(desc(reconciliations.statementEndDate))
      .limit(1);
    if (last && d.statementEndDate <= last.statementEndDate) {
      throw new AppError("invalid_input", `The last reconciliation ended ${last.statementEndDate}; pick a later statement date.`);
    }
  }
  await ctx.tx
    .update(reconciliations)
    .set({
      statementEndDate: d.statementEndDate ?? rec.statementEndDate,
      statementEndingBalance: d.statementEndingBalance ?? rec.statementEndingBalance,
      updatedAt: sql`now()`,
    })
    .where(eq(reconciliations.id, rec.id));
  await audit(ctx, "bank.reconciliation.updated", rec, {
    previousEndDate: rec.statementEndDate,
    previousEndingBalance: rec.statementEndingBalance,
    statementEndDate: d.statementEndDate ?? rec.statementEndDate,
    statementEndingBalance: d.statementEndingBalance ?? rec.statementEndingBalance,
  });
  return getReconciliation(ctx, { id: rec.id });
}

export async function completeReconciliation(ctx: Ctx, input: { id: string }): Promise<ReconciliationWorksheet> {
  requirePermission(ctx.actor, "write", "accountant", "reconcile accounts");
  const { id: recId } = z.object({ id }).parse(input);
  const rec = await loadRec(ctx, recId, true);
  if (rec.status !== "in_progress") throw invalidState(`This reconciliation is ${rec.status.replace("_", " ")}.`);
  const sheet = await getReconciliation(ctx, { id: rec.id });
  if (!money(sheet.difference).isZero()) {
    throw new AppError(
      "invalid_input",
      `Off by ${money(sheet.difference).toFixed(2)}: the cleared balance is ${money(sheet.clearedBalance).toFixed(2)}, the statement says ${money(rec.statementEndingBalance).toFixed(2)}.`,
      { difference: money(sheet.difference).toFixed(2) }
    );
  }
  const ids = sheet.lines.filter((l) => l.cleared).map((l) => l.glLineId);
  if (ids.length > 0) {
    await ctx.tx
      .update(glLineClearings)
      .set({ status: "reconciled", reconciliationId: rec.id })
      .where(inArray(glLineClearings.glLineId, ids));
  }
  await ctx.tx
    .update(reconciliations)
    .set({
      status: "completed",
      clearedBalance: sheet.clearedBalance,
      clearedCount: ids.length,
      completedAt: sql`now()`,
      completedBy: ctx.actor.userId,
      updatedAt: sql`now()`,
    })
    .where(eq(reconciliations.id, rec.id));
  await audit(ctx, "bank.reconciliation.completed", rec, { lines: ids.length, clearedBalance: sheet.clearedBalance });
  return getReconciliation(ctx, { id: rec.id });
}

export async function cancelReconciliation(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "accountant", "reconcile accounts");
  const { id: recId } = z.object({ id }).parse(input);
  const rec = await loadRec(ctx, recId, true);
  if (rec.status !== "in_progress") throw invalidState("Only an in-progress reconciliation can be cancelled.");
  // Ticks stay cleared (they reflect the statement); only the session goes.
  await ctx.tx.delete(reconciliations).where(eq(reconciliations.id, rec.id));
  await audit(ctx, "bank.reconciliation.cancelled", rec);
  return { id: rec.id };
}

export const UndoReconciliationSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

/** Reopen the latest completed reconciliation: its lines go back to cleared. Admins only. */
export async function undoReconciliation(ctx: Ctx, input: z.input<typeof UndoReconciliationSchema>): Promise<Reconciliation> {
  requirePermission(ctx.actor, "write", "admin", "undo reconciliations");
  const d = UndoReconciliationSchema.parse(input);
  const rec = await loadRec(ctx, d.id, true);
  if (rec.status !== "completed") throw invalidState("Only a completed reconciliation can be undone.");
  const [later] = await ctx.tx
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.accountId, rec.accountId),
        ne(reconciliations.id, rec.id),
        sql`${reconciliations.status} IN ('completed', 'in_progress')`,
        gt(reconciliations.statementEndDate, rec.statementEndDate)
      )
    )
    .limit(1);
  if (later) throw invalidState("Only the most recent reconciliation can be undone; undo (or cancel) the later one first.");
  await ctx.tx
    .update(glLineClearings)
    .set({ status: "cleared" })
    .where(eq(glLineClearings.reconciliationId, rec.id));
  const [undone] = await ctx.tx
    .update(reconciliations)
    .set({ status: "undone", undoneAt: sql`now()`, undoneBy: ctx.actor.userId, undoReason: d.reason, updatedAt: sql`now()` })
    .where(eq(reconciliations.id, rec.id))
    .returning();
  await audit(ctx, "bank.reconciliation.undone", rec, { reason: d.reason });
  return undone;
}

export const ListReconciliationsSchema = z.object({ accountId: id.optional(), ...pagination });

export async function listReconciliations(ctx: Ctx, input: z.input<typeof ListReconciliationsSchema>) {
  requirePermission(ctx.actor, "read", "viewer", "list reconciliations");
  const f = ListReconciliationsSchema.parse(input);
  const rows = await ctx.tx
    .select({ r: reconciliations, accountCode: accounts.code, accountName: accounts.name })
    .from(reconciliations)
    .innerJoin(accounts, eq(accounts.id, reconciliations.accountId))
    .where(
      and(
        eq(reconciliations.organizationId, ctx.actor.organizationId),
        f.accountId ? eq(reconciliations.accountId, f.accountId) : undefined
      )
    )
    .orderBy(desc(reconciliations.statementEndDate), desc(reconciliations.createdAt))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((x) => ({ ...x.r, accountCode: x.accountCode, accountName: x.accountName })),
    f.limit,
    f.offset
  );
}

export type ReconciliationReport = {
  reconciliation: Reconciliation & { accountCode: string; accountName: string };
  /** Lines this reconciliation locked in. */
  reconciled: WorksheetLine[];
  /** Lines on or before the statement date still uncleared today. */
  uncleared: WorksheetLine[];
};

/** What was reconciled, and what was still outstanding, for an auditor or the owner. */
export async function getReconciliationReport(ctx: Ctx, input: { id: string }): Promise<ReconciliationReport> {
  requirePermission(ctx.actor, "read", "viewer", "view reconciliation reports");
  const { id: recId } = z.object({ id }).parse(input);
  const rec = await loadRec(ctx, recId);
  const [account] = await ctx.tx.select().from(accounts).where(eq(accounts.id, rec.accountId));
  const sign = natural(account);
  const select = {
    glLineId: glLines.id,
    journalId: glJournals.id,
    journalNumber: glJournals.journalNumber,
    date: glJournals.journalDate,
    description: sql<string>`coalesce(${glLines.memo}, ${glJournals.description})`,
    payee: sql<string | null>`NULL`,
    amount: lineAmount,
    cleared: sql<boolean>`${isClearedOrReconciled}`,
  };
  const base = and(eq(glLines.organizationId, ctx.actor.organizationId), eq(glLines.accountId, rec.accountId), inLedger());
  const [reconciled, uncleared] = await Promise.all([
    ctx.tx
      .select(select)
      .from(glLines)
      .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
      .innerJoin(glLineClearings, eq(glLineClearings.glLineId, glLines.id))
      .where(and(base, eq(glLineClearings.reconciliationId, rec.id), eq(glLineClearings.status, "reconciled")))
      .orderBy(glJournals.journalDate, glJournals.journalNumber),
    ctx.tx
      .select(select)
      .from(glLines)
      .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
      .where(and(base, lte(glJournals.journalDate, rec.statementEndDate), sql`NOT ${isClearedOrReconciled}`))
      .orderBy(glJournals.journalDate, glJournals.journalNumber),
  ]);
  const flip = (rows: typeof reconciled) => rows.map((r) => ({ ...r, amount: toDbMoney(money(r.amount).times(sign)) }));
  return {
    reconciliation: { ...rec, accountCode: account.code, accountName: account.name },
    reconciled: flip(reconciled),
    uncleared: flip(uncleared),
  };
}

async function audit(ctx: Ctx, event: string, rec: Reconciliation, metadata: Record<string, unknown> = {}) {
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event,
      entityType: "reconciliation",
      entityId: rec.id,
      metadata: {
        accountId: rec.accountId,
        statementEndDate: rec.statementEndDate,
        statementEndingBalance: rec.statementEndingBalance,
        ...metadata,
      },
    },
    ctx.tx
  );
}

// ---------------------------------------------------------------------------
// Overview + register
// ---------------------------------------------------------------------------

export type BankAccountOverview = {
  id: string;
  code: string;
  name: string;
  normalBalance: Account["normalBalance"];
  /** Natural sign: cash in the bank, or owed on a card. */
  bookBalance: string;
  clearedBalance: string;
  forReview: number;
  lastReconciled: { date: string; balance: string } | null;
  inProgressReconciliationId: string | null;
  /** The latest import, and the balance its file reported (OFX / QFX only), in natural sign. */
  lastImport: { at: Date; ledgerBalance: string | null; ledgerBalanceDate: string | null } | null;
};

/** Every reconcilable account with its book balance, cleared balance, and review status. */
export async function listBankAccountsOverview(ctx: Ctx): Promise<BankAccountOverview[]> {
  requirePermission(ctx.actor, "read", "viewer", "view bank accounts");
  const org = ctx.actor.organizationId;
  const accts = await ctx.tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, org),
        eq(accounts.isReconciliation, true),
        eq(accounts.isActive, true),
        eq(accounts.accountType, "posting"),
        isNull(accounts.deletedAt)
      )
    )
    .orderBy(accounts.code);
  const counts = await forReviewCounts(ctx);
  return Promise.all(
    accts.map(async (a) => {
      const sign = natural(a);
      const [book, cleared, [last], [open], [imp]] = await Promise.all([
        sumLines(ctx, a.id, undefined),
        sumLines(ctx, a.id, isClearedOrReconciled),
        ctx.tx
          .select({ date: reconciliations.statementEndDate, balance: reconciliations.statementEndingBalance })
          .from(reconciliations)
          .where(and(eq(reconciliations.accountId, a.id), eq(reconciliations.status, "completed")))
          .orderBy(desc(reconciliations.statementEndDate))
          .limit(1),
        ctx.tx
          .select({ id: reconciliations.id })
          .from(reconciliations)
          .where(and(eq(reconciliations.accountId, a.id), eq(reconciliations.status, "in_progress"))),
        ctx.tx
          .select({
            at: bankStatementImports.createdAt,
            ledgerBalance: bankStatementImports.ledgerBalance,
            ledgerBalanceDate: bankStatementImports.ledgerBalanceDate,
          })
          .from(bankStatementImports)
          .where(eq(bankStatementImports.accountId, a.id))
          .orderBy(desc(bankStatementImports.createdAt))
          .limit(1),
      ]);
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        normalBalance: a.normalBalance,
        bookBalance: toDbMoney(book.times(sign)),
        clearedBalance: toDbMoney(cleared.times(sign)),
        forReview: counts.get(a.id) ?? 0,
        lastReconciled: last ?? null,
        inProgressReconciliationId: open?.id ?? null,
        lastImport: imp
          ? { ...imp, ledgerBalance: imp.ledgerBalance === null ? null : toDbMoney(money(imp.ledgerBalance).times(sign)) }
          : null,
      };
    })
  );
}

export const RegisterSchema = z.object({
  accountId: id,
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pagination,
});

export type RegisterRow = {
  glLineId: string;
  journalId: string;
  journalNumber: string;
  date: string;
  description: string;
  payee: string | null;
  reference: string | null;
  /** Natural sign. */
  amount: string;
  /** Running balance after this line, natural sign. */
  balance: string;
  clearing: "cleared" | "reconciled" | null;
  source: {
    type: "bank_transaction" | "customer_payment" | "bill_payment" | "sales_receipt" | "refund_receipt" | "sales_tax_payment" | "journal";
    id: string;
  };
};

/** Every ledger line on the account, newest first, with a running balance and cleared state. */
export async function getAccountRegister(ctx: Ctx, input: z.input<typeof RegisterSchema>): Promise<Page<RegisterRow>> {
  requirePermission(ctx.actor, "read", "viewer", "view account registers");
  const f = RegisterSchema.parse(input);
  const account = await requireBankingAccount(ctx.tx, ctx.actor.organizationId, f.accountId);
  const sign = natural(account);
  const rows = await ctx.tx.execute<{
    gl_line_id: string;
    journal_id: string;
    journal_number: string;
    date: string;
    description: string;
    payee: string | null;
    reference: string | null;
    amount: string;
    balance: string;
    clearing: "cleared" | "reconciled" | null;
    bank_txn_id: string | null;
    ar_payment_id: string | null;
    ap_payment_id: string | null;
    sales_receipt_id: string | null;
    refund_id: string | null;
    tax_payment_id: string | null;
  }>(sql`
    WITH lines AS (
      SELECT l.id AS gl_line_id, j.id AS journal_id, j.journal_number, j.journal_date AS date,
             coalesce(l.memo, j.description) AS description,
             coalesce(v.name, c.name) AS payee, coalesce(l.reference, j.document_no) AS reference,
             (l.debit_local - l.credit_local) AS amount,
             sum(l.debit_local - l.credit_local) OVER (ORDER BY j.journal_date, j.journal_number, l.id) AS balance,
             cl.status AS clearing
        FROM gl_lines l
        JOIN gl_journals j ON j.id = l.journal_id
        LEFT JOIN vendors v ON v.id = l.vendor_id
        LEFT JOIN customers c ON c.id = l.customer_id
        LEFT JOIN gl_line_clearings cl ON cl.gl_line_id = l.id
       WHERE l.organization_id = ${ctx.actor.organizationId}
         AND l.account_id = ${account.id}
         AND j.status IN ('posted', 'reversed')
    )
    SELECT lines.*,
           (SELECT bt.id FROM bank_transactions bt WHERE bt.gl_journal_id = lines.journal_id OR bt.void_gl_journal_id = lines.journal_id LIMIT 1) AS bank_txn_id,
           (SELECT p.id FROM ar_payments p WHERE p.gl_journal_id = lines.journal_id OR p.void_gl_journal_id = lines.journal_id LIMIT 1) AS ar_payment_id,
           (SELECT p.id FROM ap_payments p WHERE p.gl_journal_id = lines.journal_id OR p.void_gl_journal_id = lines.journal_id LIMIT 1) AS ap_payment_id,
           (SELECT r.id FROM sales_receipts r WHERE r.gl_journal_id = lines.journal_id OR r.void_gl_journal_id = lines.journal_id LIMIT 1) AS sales_receipt_id,
           (SELECT r.id FROM refund_receipts r WHERE r.gl_journal_id = lines.journal_id OR r.void_gl_journal_id = lines.journal_id LIMIT 1) AS refund_id,
           (SELECT t.id FROM sales_tax_payments t WHERE t.gl_journal_id = lines.journal_id OR t.void_gl_journal_id = lines.journal_id LIMIT 1) AS tax_payment_id
      FROM lines
     WHERE (${f.from ?? null}::date IS NULL OR lines.date >= ${f.from ?? null}::date)
       AND (${f.to ?? null}::date IS NULL OR lines.date <= ${f.to ?? null}::date)
     ORDER BY lines.date DESC, lines.journal_number DESC, lines.gl_line_id DESC
     LIMIT ${f.limit + 1} OFFSET ${f.offset}
  `);
  return toPage(
    rows.map((r) => ({
      glLineId: r.gl_line_id,
      journalId: r.journal_id,
      journalNumber: r.journal_number,
      date: String(r.date),
      description: r.description,
      payee: r.payee,
      reference: r.reference,
      amount: toDbMoney(money(r.amount).times(sign)),
      balance: toDbMoney(money(r.balance).times(sign)),
      clearing: r.clearing,
      source: r.bank_txn_id
        ? { type: "bank_transaction" as const, id: r.bank_txn_id }
        : r.ar_payment_id
          ? { type: "customer_payment" as const, id: r.ar_payment_id }
          : r.ap_payment_id
            ? { type: "bill_payment" as const, id: r.ap_payment_id }
            : r.sales_receipt_id
              ? { type: "sales_receipt" as const, id: r.sales_receipt_id }
              : r.refund_id
                ? { type: "refund_receipt" as const, id: r.refund_id }
                : r.tax_payment_id
                  ? { type: "sales_tax_payment" as const, id: r.tax_payment_id }
                  : { type: "journal" as const, id: r.journal_id },
    })),
    f.limit,
    f.offset
  );
}
