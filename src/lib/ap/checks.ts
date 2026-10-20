import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  apBills,
  apPaymentApplications,
  apPayments,
  bankTransactionLines,
  bankTransactions,
  customers,
  vendors,
  type Account,
  type Address,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { money } from "@/lib/money";
import { id } from "@/lib/schemas";

/**
 * PRINTED CHECKS. A bill payment or a banking check marked "print later"
 * waits in the print queue. Printing gives each one the next check number
 * of its bank account (and moves the account's counter on); the PDF puts
 * each check on its own voucher page. A check that jams can be put back in
 * the queue to print again under a new number.
 */

export const CHECK_KINDS = ["bill_payment", "check"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const CheckRefSchema = z.object({
  kind: z.enum(CHECK_KINDS).describe("bill_payment (from Pay bills) or check (a banking check)."),
  id,
});
export type CheckRef = z.output<typeof CheckRefSchema>;

/** Only checks drawn on a bank account can be printed: not a card, not cash. */
export function assertPrintLater(account: Account, opts: { isCheck: boolean; reference?: string | null }) {
  if (!opts.isCheck) throw new AppError("invalid_input", "Only checks can be printed later.");
  if (!account.isReconciliation || account.normalBalance !== "debit") {
    throw new AppError("invalid_input", `${account.code} ${account.name} isn't a bank account; checks print from a bank account.`);
  }
  if (opts.reference) throw new AppError("invalid_input", "A check to print later gets its number when it prints; leave the check number empty.");
}

export type QueuedCheck = {
  kind: CheckKind;
  id: string;
  documentNumber: string;
  date: string;
  payee: string;
  amount: string;
  currency: string;
  bankAccountId: string;
  bankAccountName: string;
};

export const ListChecksToPrintSchema = z.object({
  bankAccountId: id.optional().describe("Only this bank account's checks."),
});

/** Posted checks waiting to print, oldest first. */
export async function listChecksToPrint(ctx: Ctx, input: z.input<typeof ListChecksToPrintSchema> = {}): Promise<QueuedCheck[]> {
  requirePermission(ctx.actor, "read", "viewer", "view the check print queue");
  const f = ListChecksToPrintSchema.parse(input);
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<QueuedCheck>(sql`
    SELECT * FROM (
      SELECT 'bill_payment' AS kind, p.id, p.payment_number AS "documentNumber", p.payment_date::text AS date,
             v.name AS payee, p.net_amount::text AS amount, p.currency, p.bank_account_id AS "bankAccountId",
             a.code || ' ' || a.name AS "bankAccountName"
        FROM ap_payments p
        JOIN vendors v ON v.id = p.vendor_id
        JOIN accounts a ON a.id = p.bank_account_id
       WHERE p.organization_id = ${org} AND p.status = 'posted' AND p.to_print AND p.deleted_at IS NULL
      UNION ALL
      SELECT 'check', t.id, t.txn_number, t.txn_date::text,
             COALESCE(t.payee_name, v.name, c.name, 'Cash'), t.total_amount::text, t.currency, t.bank_account_id,
             a.code || ' ' || a.name
        FROM bank_transactions t
        LEFT JOIN vendors v ON v.id = t.vendor_id
        LEFT JOIN customers c ON c.id = t.customer_id
        JOIN accounts a ON a.id = t.bank_account_id
       WHERE t.organization_id = ${org} AND t.type = 'check' AND t.status = 'posted' AND t.to_print AND t.deleted_at IS NULL
    ) q
    ${f.bankAccountId ? sql`WHERE q."bankAccountId" = ${f.bankAccountId}` : sql``}
    ORDER BY q.date, q."documentNumber"
  `);
  return rows;
}

export const PrintChecksSchema = z.object({
  bankAccountId: id.describe("The bank account the checks are drawn on; all of them must be."),
  firstCheckNumber: z.number().int().min(1).max(999999999).describe("Number of the first check in the printer. The rest follow in order."),
  checks: z.array(CheckRefSchema).min(1).max(100).describe("Queued checks to print, in printing order."),
});

/** Number the checks (in order) and take them out of the queue. */
export async function printChecks(ctx: Ctx, input: z.input<typeof PrintChecksSchema>) {
  requirePermission(ctx.actor, "write", "bookkeeper", "print checks");
  const d = PrintChecksSchema.parse(input);
  const org = ctx.actor.organizationId;
  const [bank] = await ctx.tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, d.bankAccountId), eq(accounts.organizationId, org)))
    .for("update");
  if (!bank) throw notFound("Bank account");
  const seen = new Set<string>();
  const printed: Array<CheckRef & { checkNumber: string }> = [];
  let n = d.firstCheckNumber;
  for (const ref of d.checks) {
    if (seen.has(ref.id)) throw new AppError("invalid_input", "Each check can appear only once.");
    seen.add(ref.id);
    const doc = await loadQueued(ctx, ref);
    if (doc.bankAccountId !== bank.id) throw new AppError("invalid_input", `${doc.number} is drawn on another bank account.`);
    const checkNumber = String(n++);
    const values = { reference: checkNumber, toPrint: false, printedAt: sql`now()`, updatedAt: sql`now()` };
    if (ref.kind === "bill_payment") await ctx.tx.update(apPayments).set(values).where(eq(apPayments.id, ref.id));
    else await ctx.tx.update(bankTransactions).set(values).where(eq(bankTransactions.id, ref.id));
    printed.push({ ...ref, checkNumber });
  }
  await ctx.tx.update(accounts).set({ nextCheckNumber: n, updatedAt: sql`now()` }).where(eq(accounts.id, bank.id));
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ap.checks.printed",
      entityType: "account",
      entityId: bank.id,
      metadata: { count: printed.length, first: printed[0]?.checkNumber, last: printed[printed.length - 1]?.checkNumber, checks: printed },
    },
    ctx.tx
  );
  return { checks: printed, nextCheckNumber: n };
}

async function loadQueued(ctx: Ctx, ref: CheckRef) {
  const doc = await loadCheckDoc(ctx, ref, true);
  if (doc.status !== "posted") throw invalidState(`${doc.number} is ${doc.status}; only posted checks print.`);
  if (!doc.toPrint) throw invalidState(`${doc.number} isn't waiting to print. Put it back in the queue to print it again.`);
  return doc;
}

async function loadCheckDoc(ctx: Ctx, ref: CheckRef, lock = false) {
  const org = ctx.actor.organizationId;
  if (ref.kind === "bill_payment") {
    const q = ctx.tx
      .select()
      .from(apPayments)
      .where(and(eq(apPayments.id, ref.id), eq(apPayments.organizationId, org), isNull(apPayments.deletedAt)));
    const [p] = lock ? await q.for("update") : await q;
    if (!p) throw notFound("Bill payment");
    return { number: p.paymentNumber, status: p.status, toPrint: p.toPrint, bankAccountId: p.bankAccountId, method: p.method, reference: p.reference };
  }
  const q = ctx.tx
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, ref.id), eq(bankTransactions.organizationId, org), isNull(bankTransactions.deletedAt)));
  const [t] = lock ? await q.for("update") : await q;
  if (!t) throw notFound("Bank transaction");
  if (t.type !== "check") throw invalidState(`${t.txnNumber} is a${t.type === "expense" ? "n" : ""} ${t.type}, not a check.`);
  return { number: t.txnNumber, status: t.status, toPrint: t.toPrint, bankAccountId: t.bankAccountId, method: t.method, reference: t.reference };
}

/** Put a posted check (back) in the print queue; it gets a new number when it prints. */
export async function queueCheck(ctx: Ctx, ref: CheckRef) {
  requirePermission(ctx.actor, "write", "bookkeeper", "queue checks for printing");
  const r = CheckRefSchema.parse(ref);
  const doc = await loadCheckDoc(ctx, r, true);
  if (doc.status !== "posted") throw invalidState(`${doc.number} is ${doc.status}; only posted checks print.`);
  if (r.kind === "bill_payment" && doc.method !== "check") throw invalidState(`${doc.number} wasn't paid by check.`);
  const [bank] = await ctx.tx.select().from(accounts).where(eq(accounts.id, doc.bankAccountId));
  assertPrintLater(bank, { isCheck: true });
  const values = { toPrint: true, reference: null, updatedAt: sql`now()` };
  if (r.kind === "bill_payment") await ctx.tx.update(apPayments).set(values).where(eq(apPayments.id, r.id));
  else await ctx.tx.update(bankTransactions).set(values).where(eq(bankTransactions.id, r.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.check.queued",
      entityType: r.kind === "bill_payment" ? "ap_payment" : "bank_transaction",
      entityId: r.id,
      metadata: { number: doc.number, previousCheckNumber: doc.reference },
    },
    ctx.tx
  );
  return { ...r, toPrint: true };
}

// ---------------------------------------------------------------------------
// What goes on a printed check
// ---------------------------------------------------------------------------

export type CheckPrint = {
  checkNumber: string | null;
  date: string;
  payee: string;
  payeeAddress: string[];
  amount: string;
  currency: string;
  memo: string | null;
  bankAccountName: string;
  /** Stub rows: what the check pays. */
  stub: Array<{ ref: string; date: string | null; description: string; amount: string; discount: string | null }>;
};

function mailing(addresses: unknown): string[] {
  const list = Array.isArray(addresses) ? (addresses as Address[]) : [];
  const a = list.find((x) => x.type === "remit") ?? list.find((x) => x.type === "mailing") ?? list.find((x) => x.type === "billing") ?? list[0];
  if (!a) return [];
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.street1, a.street2, cityLine, a.country].filter((l): l is string => Boolean(l && l.trim()));
}

export async function checkPrint(ctx: Ctx, ref: CheckRef): Promise<CheckPrint> {
  requirePermission(ctx.actor, "read", "viewer", "print checks");
  const r = CheckRefSchema.parse(ref);
  const org = ctx.actor.organizationId;
  if (r.kind === "bill_payment") {
    const [row] = await ctx.tx
      .select({ p: apPayments, vendor: vendors, bank: accounts })
      .from(apPayments)
      .innerJoin(vendors, eq(vendors.id, apPayments.vendorId))
      .innerJoin(accounts, eq(accounts.id, apPayments.bankAccountId))
      .where(and(eq(apPayments.id, r.id), eq(apPayments.organizationId, org), isNull(apPayments.deletedAt)));
    if (!row) throw notFound("Bill payment");
    if (row.p.method !== "check") throw invalidState(`${row.p.paymentNumber} wasn't paid by check.`);
    if (row.p.status !== "posted") throw invalidState(`${row.p.paymentNumber} is ${row.p.status}; only posted checks print.`);
    const apps = await ctx.tx
      .select({ a: apPaymentApplications, billNumber: apBills.billNumber, vendorInvoice: apBills.vendorInvoiceNumber, billDate: apBills.billDate })
      .from(apPaymentApplications)
      .innerJoin(apBills, eq(apBills.id, apPaymentApplications.billId))
      .where(eq(apPaymentApplications.paymentId, r.id))
      .orderBy(asc(apBills.billDate));
    return {
      checkNumber: row.p.toPrint ? null : row.p.reference,
      date: row.p.paymentDate,
      payee: row.vendor.name,
      payeeAddress: mailing(row.vendor.addresses),
      amount: row.p.netAmount,
      currency: row.p.currency,
      memo: row.p.memo,
      bankAccountName: row.bank.name,
      stub: apps.map((a) => ({
        ref: a.vendorInvoice ?? a.billNumber,
        date: a.billDate,
        description: `Bill ${a.billNumber}`,
        amount: a.a.appliedAmount,
        discount: Number(a.a.discountAmount) ? a.a.discountAmount : null,
      })),
    };
  }
  const [row] = await ctx.tx
    .select({ t: bankTransactions, bank: accounts, vendor: vendors, customer: customers })
    .from(bankTransactions)
    .innerJoin(accounts, eq(accounts.id, bankTransactions.bankAccountId))
    .leftJoin(vendors, eq(vendors.id, bankTransactions.vendorId))
    .leftJoin(customers, eq(customers.id, bankTransactions.customerId))
    .where(and(eq(bankTransactions.id, r.id), eq(bankTransactions.organizationId, org), isNull(bankTransactions.deletedAt)));
  if (!row) throw notFound("Bank transaction");
  if (row.t.type !== "check") throw invalidState(`${row.t.txnNumber} isn't a check.`);
  if (row.t.status !== "posted") throw invalidState(`${row.t.txnNumber} is ${row.t.status}; only posted checks print.`);
  const lines = await ctx.tx
    .select({ l: bankTransactionLines, accountName: accounts.name })
    .from(bankTransactionLines)
    .innerJoin(accounts, eq(accounts.id, bankTransactionLines.accountId))
    .where(eq(bankTransactionLines.transactionId, r.id))
    .orderBy(asc(bankTransactionLines.lineNumber));
  const party = row.vendor ?? row.customer;
  return {
    checkNumber: row.t.toPrint ? null : row.t.reference,
    date: row.t.txnDate,
    payee: row.t.payeeName ?? party?.name ?? "Cash",
    payeeAddress: party ? mailing(party.addresses) : [],
    amount: row.t.totalAmount,
    currency: row.t.currency,
    memo: row.t.memo,
    bankAccountName: row.bank.name,
    stub: lines.map((l) => ({ ref: l.accountName, date: null, description: l.l.description ?? "", amount: l.l.amount, discount: null })),
  };
}

/** Bank accounts (not cards) with their next check number, for the print screen. */
export async function checkingAccounts(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "view bank accounts");
  return ctx.tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, nextCheckNumber: accounts.nextCheckNumber })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, ctx.actor.organizationId),
        eq(accounts.isReconciliation, true),
        eq(accounts.normalBalance, "debit"),
        eq(accounts.isActive, true),
        inArray(accounts.accountType, ["posting"])
      )
    )
    .orderBy(asc(accounts.code));
}

// ---------------------------------------------------------------------------
// Amount in words, as written on a check
// ---------------------------------------------------------------------------

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion"];

function underThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

/** "1234.56" → "One thousand two hundred thirty-four and 56/100". */
export function amountInWords(amount: string): string {
  const value = money(amount);
  if (value.isNegative()) throw new AppError("invalid_input", "A check amount must be zero or more.");
  const [whole, frac] = value.toFixed(2).split(".");
  if (whole.length > 12) throw new AppError("invalid_input", "A check amount must be under one trillion.");
  // Whole dollars below a trillion fit a JS number exactly.
  let n = Number(whole);
  const groups: string[] = [];
  for (let i = 0; n > 0 && i < SCALES.length; i++) {
    const chunk = n % 1000;
    if (chunk) groups.unshift(`${underThousand(chunk)}${SCALES[i] ? ` ${SCALES[i]}` : ""}`);
    n = Math.floor(n / 1000);
  }
  const words = groups.length ? groups.join(" ") : "zero";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} and ${frac}/100`;
}
