import { aliasedTable, and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  arPayments,
  bankStatementLines,
  bankTransactionLines,
  bankTransactions,
  bankTxnStatus,
  bankTxnType,
  customers,
  glLineClearings,
  glLines,
  paymentMethod,
  salesReceipts,
  vendors,
  type BankTransaction,
  type BankTransactionLine,
  type DimensionTag,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, requirePostingWithinLimit, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { requireDimensionTags, requireLineAccounts } from "@/lib/gl/lookups";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { requireActiveCustomer, requireActiveVendor } from "@/lib/parties/service";
import { postOrQueueForReview, type ReviewNotice } from "@/lib/review-policy";
import {
  amount,
  currency,
  id,
  isoDate,
  likePattern,
  optionalText,
  pagination,
  positiveAmount,
  toPage,
  type Page,
} from "@/lib/schemas";
import { DimensionTagSchema, requireBankingAccount } from "./common";
import { linkPostedTransactionToStatement } from "./matching";
import { bankTxnLabel, postBankTransactionToGl, voidBankTransactionFromGl } from "./posting";

/**
 * BANK TRANSACTIONS — Expense, Check, Deposit, Transfer. Same lifecycle as
 * every document: draft → posted → voided, with `post: true` to finish in
 * one call (agents over their limit get a review notice instead).
 */

const LineSchema = z.object({
  accountId: id.describe(
    "Category account: expense, income, asset, liability, or equity. Not a control account (AR/AP)."
  ),
  amount: amount.describe("Line amount. A negative line flips its side (e.g. a refund line on an expense)."),
  description: optionalText(500),
  customerId: id.optional().describe("Customer this line is for (billable expense, or who paid on a deposit)."),
  dimensions: z.array(DimensionTagSchema).optional(),
});

const payee = {
  vendorId: id.optional().describe("Payee, when it's a vendor."),
  customerId: id.optional().describe("Payee / payer, when it's a customer."),
  payeeName: optionalText(200).describe("Payee name when it isn't a vendor or customer (or to override)."),
};

export const CreateExpenseSchema = z.object({
  type: z
    .enum(["expense", "check"])
    .default("expense")
    .describe("expense = card / debit / ACH spend; check = a written check (put the number in reference)."),
  txnDate: isoDate,
  bankAccountId: id.describe("Bank or credit card account the money comes out of."),
  ...payee,
  method: z.enum(paymentMethod.enumValues).optional(),
  reference: optionalText(100).describe("Check number, card reference, or confirmation."),
  memo: optionalText(500),
  currency: currency.optional(),
  exchangeRate: amount.optional(),
  lines: z.array(LineSchema).min(1, "Add at least one line."),
  post: z.boolean().optional().describe("Post to the ledger in the same call."),
});
export type CreateExpenseInput = z.input<typeof CreateExpenseSchema>;

export const CreateDepositSchema = z
  .object({
    txnDate: isoDate,
    bankAccountId: id.describe("Bank account the money lands in."),
    paymentIds: z
      .array(id)
      .optional()
      .describe(
        "Customer payments and sales receipts waiting in Undeposited Funds to include (see list_undeposited_payments). Each moves into the bank."
      ),
    lines: z
      .array(LineSchema)
      .optional()
      .describe("Other money in this deposit: owner contributions, refunds, interest, loans…"),
    ...payee,
    reference: optionalText(100),
    memo: optionalText(500),
    currency: currency.optional(),
    exchangeRate: amount.optional(),
    post: z.boolean().optional().describe("Post to the ledger in the same call."),
  })
  .refine((d) => (d.paymentIds?.length ?? 0) + (d.lines?.length ?? 0) > 0, {
    message: "Include at least one payment or line.",
  });
export type CreateDepositInput = z.input<typeof CreateDepositSchema>;

export const CreateTransferSchema = z.object({
  txnDate: isoDate,
  fromAccountId: id.describe("Bank or credit card account the money leaves."),
  toAccountId: id.describe("Bank or credit card account it goes to. Paying a card = transfer from checking to the card."),
  amount: positiveAmount,
  reference: optionalText(100),
  memo: optionalText(500),
  post: z.boolean().optional().describe("Post to the ledger in the same call."),
});
export type CreateTransferInput = z.input<typeof CreateTransferSchema>;

export const ListBankTransactionsSchema = z.object({
  type: z.enum(bankTxnType.enumValues).optional(),
  status: z.enum(bankTxnStatus.enumValues).optional(),
  bankAccountId: id.optional().describe("Only transactions on this bank / card account (either side of a transfer)."),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(200).optional().describe("Search payee, reference, memo, or number."),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type BankTransactionRow = BankTransaction & {
  bankAccountName: string;
  transferAccountName: string | null;
  payee: string | null;
};
export type BankTransactionDetail = BankTransactionRow & {
  lines: Array<BankTransactionLine & { accountCode: string; accountName: string; paymentNumber: string | null }>;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const bankAcct = aliasedTable(accounts, "bank_acct");
const xferAcct = aliasedTable(accounts, "xfer_acct");

function rowSelect() {
  return {
    t: bankTransactions,
    bankAccountName: bankAcct.name,
    transferAccountName: xferAcct.name,
    vendorName: vendors.name,
    customerName: customers.name,
  };
}

function toRow(r: {
  t: BankTransaction;
  bankAccountName: string;
  transferAccountName: string | null;
  vendorName: string | null;
  customerName: string | null;
}): BankTransactionRow {
  return {
    ...r.t,
    bankAccountName: r.bankAccountName,
    transferAccountName: r.transferAccountName,
    payee: r.t.payeeName ?? r.vendorName ?? r.customerName,
  };
}

export async function listBankTransactions(
  ctx: Ctx,
  input: z.input<typeof ListBankTransactionsSchema>
): Promise<Page<BankTransactionRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list bank transactions");
  const f = ListBankTransactionsSchema.parse(input);
  const q = f.q ? likePattern(f.q) : null;
  const rows = await ctx.tx
    .select(rowSelect())
    .from(bankTransactions)
    .innerJoin(bankAcct, eq(bankAcct.id, bankTransactions.bankAccountId))
    .leftJoin(xferAcct, eq(xferAcct.id, bankTransactions.transferAccountId))
    .leftJoin(vendors, eq(vendors.id, bankTransactions.vendorId))
    .leftJoin(customers, eq(customers.id, bankTransactions.customerId))
    .where(
      and(
        eq(bankTransactions.organizationId, ctx.actor.organizationId),
        isNull(bankTransactions.deletedAt),
        f.type ? eq(bankTransactions.type, f.type) : undefined,
        f.status ? eq(bankTransactions.status, f.status) : undefined,
        f.bankAccountId
          ? or(eq(bankTransactions.bankAccountId, f.bankAccountId), eq(bankTransactions.transferAccountId, f.bankAccountId))
          : undefined,
        f.from ? gte(bankTransactions.txnDate, f.from) : undefined,
        f.to ? lte(bankTransactions.txnDate, f.to) : undefined,
        q
          ? or(
              ilike(bankTransactions.txnNumber, q),
              ilike(bankTransactions.payeeName, q),
              ilike(bankTransactions.reference, q),
              ilike(bankTransactions.memo, q),
              ilike(vendors.name, q),
              ilike(customers.name, q)
            )
          : undefined
      )
    )
    .orderBy(desc(bankTransactions.txnDate), desc(bankTransactions.txnNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map(toRow), f.limit, f.offset);
}

export async function getBankTransaction(ctx: Ctx, input: { id: string }): Promise<BankTransactionDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view bank transactions");
  const { id: txnId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select(rowSelect())
    .from(bankTransactions)
    .innerJoin(bankAcct, eq(bankAcct.id, bankTransactions.bankAccountId))
    .leftJoin(xferAcct, eq(xferAcct.id, bankTransactions.transferAccountId))
    .leftJoin(vendors, eq(vendors.id, bankTransactions.vendorId))
    .leftJoin(customers, eq(customers.id, bankTransactions.customerId))
    .where(and(eq(bankTransactions.id, txnId), eq(bankTransactions.organizationId, ctx.actor.organizationId)));
  if (!row) throw notFound("Bank transaction");
  const lines = await ctx.tx
    .select({
      l: bankTransactionLines,
      accountCode: accounts.code,
      accountName: accounts.name,
      paymentNumber: sql<string | null>`COALESCE(${arPayments.paymentNumber}, ${salesReceipts.receiptNumber})`,
    })
    .from(bankTransactionLines)
    .innerJoin(accounts, eq(accounts.id, bankTransactionLines.accountId))
    .leftJoin(arPayments, eq(arPayments.id, bankTransactionLines.arPaymentId))
    .leftJoin(salesReceipts, eq(salesReceipts.id, bankTransactionLines.salesReceiptId))
    .where(eq(bankTransactionLines.transactionId, txnId))
    .orderBy(asc(bankTransactionLines.lineNumber));
  return {
    ...toRow(row),
    lines: lines.map((l) => ({ ...l.l, accountCode: l.accountCode, accountName: l.accountName, paymentNumber: l.paymentNumber })),
  };
}

export type UndepositedPayment = {
  id: string;
  kind: "payment" | "sales_receipt";
  paymentNumber: string;
  paymentDate: string;
  customerName: string;
  method: string;
  reference: string | null;
  amount: string;
  holdingAccountId: string;
  holdingAccountName: string;
};

/**
 * Customer payments and sales receipts received into a holding account
 * (Undeposited Funds) and not yet on a deposit. A deposit moves them into
 * the bank.
 */
export async function listUndepositedPayments(ctx: Ctx): Promise<UndepositedPayment[]> {
  requirePermission(ctx.actor, "read", "viewer", "list undeposited payments");
  const org = ctx.actor.organizationId;
  const onDeposit = (col: string, idExpr: string) =>
    sql.raw(`NOT EXISTS (SELECT 1 FROM bank_transaction_lines bl JOIN bank_transactions bt ON bt.id = bl.transaction_id
       WHERE bl.${col} = ${idExpr} AND bt.status <> 'voided' AND bt.deleted_at IS NULL)`);
  const rows = await ctx.tx.execute<UndepositedPayment>(sql`
    SELECT p.id, 'payment' AS kind, p.payment_number AS "paymentNumber", p.payment_date::text AS "paymentDate",
           c.name AS "customerName", p.method::text AS method, p.reference, p.amount::text AS amount,
           a.id AS "holdingAccountId", a.name AS "holdingAccountName"
      FROM ar_payments p
      JOIN customers c ON c.id = p.customer_id
      JOIN accounts a ON a.id = p.deposit_account_id
     WHERE p.organization_id = ${org} AND p.status = 'posted' AND NOT a.is_reconciliation
       AND ${onDeposit("ar_payment_id", "p.id")}
    UNION ALL
    SELECT r.id, 'sales_receipt', r.receipt_number, r.receipt_date::text,
           COALESCE(c.name, 'Sales receipt'), r.method::text, r.reference, r.total_amount::text,
           a.id, a.name
      FROM sales_receipts r
      LEFT JOIN customers c ON c.id = r.customer_id
      JOIN accounts a ON a.id = r.deposit_account_id
     WHERE r.organization_id = ${org} AND r.status = 'posted' AND NOT a.is_reconciliation
       AND ${onDeposit("sales_receipt_id", "r.id")}
     ORDER BY 4, 3`);
  return rows.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

type LineInput = z.output<typeof LineSchema>;
type DraftLine = {
  accountId: string;
  amount: string;
  description: string | null;
  customerId: string | null;
  arPaymentId: string | null;
  salesReceiptId: string | null;
  dimensions: DimensionTag[];
};

async function validateLines(ctx: Ctx, bankAccountId: string, lines: LineInput[]): Promise<DraftLine[]> {
  const org = ctx.actor.organizationId;
  await requireLineAccounts(ctx.tx, org, lines.map((l) => l.accountId));
  if (lines.some((l) => l.accountId === bankAccountId)) {
    throw new AppError("invalid_input", "A line can't use the bank account itself; use a transfer to move money between accounts.");
  }
  await requireDimensionTags(ctx.tx, org, lines.flatMap((l) => l.dimensions ?? []));
  for (const c of new Set(lines.map((l) => l.customerId).filter((x): x is string => Boolean(x)))) {
    await requireActiveCustomer(ctx, c);
  }
  return lines.map((l) => ({
    accountId: l.accountId,
    amount: l.amount,
    description: l.description ?? null,
    customerId: l.customerId ?? null,
    arPaymentId: null,
    salesReceiptId: null,
    dimensions: (l.dimensions ?? []) as DimensionTag[],
  }));
}

async function validatePayee(ctx: Ctx, p: { vendorId?: string; customerId?: string }) {
  if (p.vendorId && p.customerId) throw new AppError("invalid_input", "Pick a vendor or a customer as the payee, not both.");
  if (p.vendorId) await requireActiveVendor(ctx, p.vendorId);
  if (p.customerId) await requireActiveCustomer(ctx, p.customerId);
}

/**
 * Payments and sales receipts for a deposit: posted, sitting in a holding
 * account, not on another live deposit.
 */
async function paymentLines(ctx: Ctx, ids: string[], excludeTxnId?: string): Promise<DraftLine[]> {
  if (ids.length === 0) return [];
  if (new Set(ids).size !== ids.length) {
    throw new AppError("invalid_input", "Each payment may appear only once on a deposit.");
  }
  const org = ctx.actor.organizationId;
  const payments = await ctx.tx
    .select({ p: arPayments, holdingIsBank: accounts.isReconciliation })
    .from(arPayments)
    .innerJoin(accounts, eq(accounts.id, arPayments.depositAccountId))
    .where(and(eq(arPayments.organizationId, org), inArray(arPayments.id, ids)))
    .for("update", { of: arPayments });
  const receipts = await ctx.tx
    .select({ r: salesReceipts, holdingIsBank: accounts.isReconciliation })
    .from(salesReceipts)
    .innerJoin(accounts, eq(accounts.id, salesReceipts.depositAccountId))
    .where(and(eq(salesReceipts.organizationId, org), inArray(salesReceipts.id, ids)))
    .for("update", { of: salesReceipts });
  if (payments.length + receipts.length !== ids.length) throw notFound("One or more customer payments");
  const docs = [
    ...payments.map(({ p, holdingIsBank }) => ({
      id: p.id,
      label: `Payment ${p.paymentNumber}`,
      status: p.status,
      holdingIsBank,
      line: {
        accountId: p.depositAccountId,
        amount: p.amount,
        description: `Payment ${p.paymentNumber}${p.reference ? ` · ${p.reference}` : ""}`,
        customerId: p.customerId,
        arPaymentId: p.id,
        salesReceiptId: null,
        dimensions: [],
      },
    })),
    ...receipts.map(({ r, holdingIsBank }) => ({
      id: r.id,
      label: `Sales receipt ${r.receiptNumber}`,
      status: r.status,
      holdingIsBank,
      line: {
        accountId: r.depositAccountId,
        amount: r.totalAmount,
        description: `Sales receipt ${r.receiptNumber}${r.reference ? ` · ${r.reference}` : ""}`,
        customerId: r.customerId,
        arPaymentId: null,
        salesReceiptId: r.id,
        dimensions: [],
      },
    })),
  ];
  for (const d of docs) {
    if (d.status !== "posted") throw invalidState(`${d.label} is ${d.status}; only posted payments can be deposited.`);
    if (d.holdingIsBank) throw invalidState(`${d.label} already went straight into a bank account.`);
  }
  const taken = await ctx.tx
    .select({ paymentId: bankTransactionLines.arPaymentId, receiptId: bankTransactionLines.salesReceiptId, txnNumber: bankTransactions.txnNumber })
    .from(bankTransactionLines)
    .innerJoin(bankTransactions, eq(bankTransactions.id, bankTransactionLines.transactionId))
    .where(
      and(
        or(inArray(bankTransactionLines.arPaymentId, ids), inArray(bankTransactionLines.salesReceiptId, ids)),
        ne(bankTransactions.status, "voided"),
        isNull(bankTransactions.deletedAt),
        excludeTxnId ? ne(bankTransactions.id, excludeTxnId) : undefined
      )
    );
  if (taken.length > 0) {
    const d = docs.find((x) => x.id === (taken[0].paymentId ?? taken[0].receiptId))!;
    throw invalidState(`${d.label} is already on deposit ${taken[0].txnNumber}.`);
  }
  // Keep the caller's order.
  return ids.map((i) => docs.find((d) => d.id === i)!.line);
}

async function insertTransaction(
  ctx: Ctx,
  header: Omit<typeof bankTransactions.$inferInsert, "organizationId" | "txnNumber" | "totalAmount">,
  lines: DraftLine[],
  total: string,
  series: "EXP" | "DEP" | "XFER"
): Promise<BankTransaction> {
  const org = ctx.actor.organizationId;
  const txnNumber = await nextNumber(ctx.tx, org, series);
  const [txn] = await ctx.tx
    .insert(bankTransactions)
    .values({ ...header, organizationId: org, txnNumber, totalAmount: total, status: "draft", ...creatorFields(ctx.actor) })
    .returning();
  if (lines.length > 0) {
    await ctx.tx.insert(bankTransactionLines).values(
      lines.map((l, i) => ({ ...l, organizationId: org, transactionId: txn.id, lineNumber: i + 1 }))
    );
  }
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "bank.transaction.created",
      entityType: "bank_transaction",
      entityId: txn.id,
      metadata: { txnNumber, type: txn.type, total, lines: lines.length },
    },
    ctx.tx
  );
  return txn;
}

async function finish(
  ctx: Ctx,
  txnId: string,
  post: boolean | undefined
): Promise<BankTransactionDetail & Partial<ReviewNotice>> {
  if (post) {
    return postOrQueueForReview(
      ctx,
      (c) => postBankTransaction(c, { id: txnId }),
      () => getBankTransaction(ctx, { id: txnId })
    );
  }
  return getBankTransaction(ctx, { id: txnId });
}

export async function createExpense(
  ctx: Ctx,
  input: CreateExpenseInput
): Promise<BankTransactionDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record expenses and checks");
  const d = CreateExpenseSchema.parse(input);
  const bank = await requireBankingAccount(ctx.tx, ctx.actor.organizationId, d.bankAccountId, { label: "Payment account" });
  await validatePayee(ctx, d);
  const lines = await validateLines(ctx, bank.id, d.lines);
  const total = sumMoney(lines.map((l) => l.amount));
  if (total.lte(0)) throw new AppError("invalid_input", "The total must be greater than zero.");
  const txn = await insertTransaction(
    ctx,
    {
      type: d.type,
      txnDate: d.txnDate,
      bankAccountId: bank.id,
      vendorId: d.vendorId,
      customerId: d.customerId,
      payeeName: d.payeeName,
      method: d.method ?? (d.type === "check" ? "check" : undefined),
      reference: d.reference,
      memo: d.memo,
      currency: d.currency ?? bank.currency ?? "USD",
      exchangeRate: d.exchangeRate ?? "1",
    },
    lines,
    toDbMoney(total),
    "EXP"
  );
  return finish(ctx, txn.id, d.post);
}

export async function createDeposit(
  ctx: Ctx,
  input: CreateDepositInput
): Promise<BankTransactionDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record deposits");
  const d = CreateDepositSchema.parse(input);
  const bank = await requireBankingAccount(ctx.tx, ctx.actor.organizationId, d.bankAccountId, { label: "Deposit account" });
  await validatePayee(ctx, d);
  const lines = [...(await paymentLines(ctx, d.paymentIds ?? [])), ...(await validateLines(ctx, bank.id, d.lines ?? []))];
  const total = sumMoney(lines.map((l) => l.amount));
  if (total.lte(0)) throw new AppError("invalid_input", "The deposit total must be greater than zero.");
  const txn = await insertTransaction(
    ctx,
    {
      type: "deposit",
      txnDate: d.txnDate,
      bankAccountId: bank.id,
      vendorId: d.vendorId,
      customerId: d.customerId,
      payeeName: d.payeeName,
      reference: d.reference,
      memo: d.memo,
      currency: d.currency ?? bank.currency ?? "USD",
      exchangeRate: d.exchangeRate ?? "1",
    },
    lines,
    toDbMoney(total),
    "DEP"
  );
  return finish(ctx, txn.id, d.post);
}

export async function createTransfer(
  ctx: Ctx,
  input: CreateTransferInput
): Promise<BankTransactionDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record transfers");
  const d = CreateTransferSchema.parse(input);
  if (d.fromAccountId === d.toAccountId) throw new AppError("invalid_input", "Pick two different accounts.");
  const org = ctx.actor.organizationId;
  const from = await requireBankingAccount(ctx.tx, org, d.fromAccountId, { label: "Transfer-from account" });
  await requireBankingAccount(ctx.tx, org, d.toAccountId, { label: "Transfer-to account" });
  const txn = await insertTransaction(
    ctx,
    {
      type: "transfer",
      txnDate: d.txnDate,
      bankAccountId: from.id,
      transferAccountId: d.toAccountId,
      reference: d.reference,
      memo: d.memo,
      currency: from.currency ?? "USD",
      exchangeRate: "1",
    },
    [],
    d.amount,
    "XFER"
  );
  return finish(ctx, txn.id, d.post);
}

// ---------------------------------------------------------------------------
// Post / void / delete
// ---------------------------------------------------------------------------

async function loadTxn(ctx: Ctx, txnId: string): Promise<BankTransaction> {
  const [t] = await ctx.tx
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, txnId), eq(bankTransactions.organizationId, ctx.actor.organizationId), isNull(bankTransactions.deletedAt)))
    .for("update");
  if (!t) throw notFound("Bank transaction");
  return t;
}

export async function postBankTransaction(ctx: Ctx, input: { id: string }): Promise<BankTransactionDetail> {
  requirePermission(ctx.actor, "post", "bookkeeper", "post bank transactions");
  const { id: txnId } = IdSchema.parse(input);
  const txn = await loadTxn(ctx, txnId);
  if (txn.status !== "draft") throw invalidState(`Only drafts can be posted (this one is ${txn.status}).`);
  requirePostingWithinLimit(ctx.actor, money(txn.totalAmount).times(money(txn.exchangeRate)), bankTxnLabel(txn));
  const lines = await ctx.tx
    .select()
    .from(bankTransactionLines)
    .where(eq(bankTransactionLines.transactionId, txnId))
    .orderBy(asc(bankTransactionLines.lineNumber));
  // A drafted deposit's payments may have been deposited elsewhere since.
  await paymentLines(ctx, lines.map((l) => l.arPaymentId ?? l.salesReceiptId).filter((x): x is string => Boolean(x)), txnId);

  const { journalId } = await postBankTransactionToGl(ctx, txn, lines);
  await ctx.tx
    .update(bankTransactions)
    .set({ status: "posted", postedAt: sql`now()`, postedBy: ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(bankTransactions.id, txnId));
  await linkPostedTransactionToStatement(ctx, txnId, journalId);
  return getBankTransaction(ctx, { id: txnId });
}

export async function voidBankTransaction(ctx: Ctx, input: z.input<typeof VoidSchema>): Promise<BankTransactionDetail> {
  requirePermission(ctx.actor, "post", "admin", "void bank transactions");
  const { id: txnId, reason } = VoidSchema.parse(input);
  const txn = await loadTxn(ctx, txnId);
  if (txn.status !== "posted") throw invalidState(`Only posted transactions can be voided (this one is ${txn.status}).`);
  // Money the bank already shows can't be voided out from under a statement.
  const [cleared] = await ctx.tx
    .select({ status: glLineClearings.status })
    .from(glLineClearings)
    .innerJoin(glLines, eq(glLines.id, glLineClearings.glLineId))
    .where(eq(glLines.journalId, txn.glJournalId!))
    .limit(1);
  if (cleared) {
    throw invalidState(
      cleared.status === "reconciled"
        ? "This transaction is in a completed reconciliation. Undo that reconciliation before voiding it."
        : "This transaction is cleared (matched to the bank statement). Undo the match or unclear it before voiding."
    );
  }
  const { journalId } = await voidBankTransactionFromGl(ctx, txn, reason);
  await ctx.tx
    .update(bankTransactions)
    .set({ status: "voided", voidedAt: sql`now()`, voidedBy: ctx.actor.userId, voidReason: reason, voidGlJournalId: journalId, updatedAt: sql`now()` })
    .where(eq(bankTransactions.id, txnId));
  // A statement line it was added from goes back to For review.
  await ctx.tx
    .update(bankStatementLines)
    .set({ status: "for_review", bankTransactionId: null, ruleId: null, reviewedBy: null, reviewedByAgentId: null, reviewedAt: null, updatedAt: sql`now()` })
    .where(and(eq(bankStatementLines.organizationId, ctx.actor.organizationId), eq(bankStatementLines.bankTransactionId, txnId)));
  return getBankTransaction(ctx, { id: txnId });
}

export async function deleteDraftBankTransaction(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft bank transactions");
  const { id: txnId } = IdSchema.parse(input);
  const txn = await loadTxn(ctx, txnId);
  if (txn.status !== "draft") throw invalidState(`Only drafts can be deleted (this one is ${txn.status}). Void it instead.`);
  await ctx.tx
    .update(bankStatementLines)
    .set({ status: "for_review", bankTransactionId: null, updatedAt: sql`now()` })
    .where(and(eq(bankStatementLines.organizationId, ctx.actor.organizationId), eq(bankStatementLines.bankTransactionId, txnId)));
  await ctx.tx.delete(bankTransactions).where(eq(bankTransactions.id, txnId));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "bank.transaction.deleted",
      entityType: "bank_transaction",
      entityId: txnId,
      metadata: { txnNumber: txn.txnNumber, type: txn.type },
    },
    ctx.tx
  );
  return { id: txnId };
}

/** Accounts a banking form can pick as the bank side: reconcilable or cash. */
export async function listBankingAccounts(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "list bank accounts");
  return ctx.tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      subcategory: accounts.subcategory,
      normalBalance: accounts.normalBalance,
      isReconciliation: accounts.isReconciliation,
      isCash: accounts.isCash,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, ctx.actor.organizationId),
        eq(accounts.accountType, "posting"),
        eq(accounts.isActive, true),
        or(eq(accounts.isReconciliation, true), eq(accounts.isCash, true)),
        eq(accounts.isBlocked, false)
      )
    )
    .orderBy(asc(accounts.code));
}
