import { eq } from "drizzle-orm";
import { apBillLines, type ApBill } from "@/lib/db/schema";
import { auditFields, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import {
  createAndPostJournal,
  reverseJournal,
  type JournalLineInput,
} from "@/lib/gl/posting";
import { controlAccount, sourceCodeId } from "@/lib/gl/lookups";
import { sumMoney, toDbMoney } from "@/lib/money";

/**
 * AP → GL posting. For a given approved bill:
 *   - Debits each line's expense account by line.amount
 *   - Credits the AP control account (the one flagged isControl and
 *     matching subcategory=payables, typically code 2000) for the total
 *
 * Runs inside the caller's transaction (ctx.tx) so a post failure rolls
 * back everything (bill status update, audit row, GL journal).
 */
export async function postBillToGl(
  ctx: Ctx,
  bill: ApBill
): Promise<{ journalId: string; journalNumber: string }> {
  const { actor, tx } = ctx;
  const organizationId = actor.organizationId;

  const apControl = await controlAccount(tx, organizationId, "payables");
  const pjSource = await sourceCodeId(tx, organizationId, "PJ");

  const lines = await tx
    .select()
    .from(apBillLines)
    .where(eq(apBillLines.billId, bill.id))
    .orderBy(apBillLines.lineNumber);

  if (lines.length === 0) {
    throw new AppError("invalid_state", "Bill has no lines to post.");
  }

  const jeLines: JournalLineInput[] = lines.map((line) => ({
    accountId: line.accountId,
    debit: toDbMoney(line.amount),
    memo: line.description ?? undefined,
    vendorId: bill.vendorId,
  }));

  // Credit AP control for the total
  const total = sumMoney(lines.map((l) => l.amount));
  jeLines.push({
    accountId: apControl.id,
    credit: toDbMoney(total),
    memo: `Bill ${bill.billNumber} — ${bill.vendorInvoiceNumber ?? "no vendor invoice #"}`,
    vendorId: bill.vendorId,
  });

  const result = await createAndPostJournal(
    {
      organizationId,
      actorId: actor.userId,
      actor,
      journalDate: bill.postingDate ?? bill.billDate,
      sourceCodeId: pjSource,
      source: "ap",
      description: bill.description ?? `Bill ${bill.billNumber}`,
      currency: bill.currency,
      exchangeRate: bill.exchangeRate,
      documentNo: bill.vendorInvoiceNumber ?? bill.billNumber,
      lines: jeLines,
    },
    tx
  );

  if (!result.ok) {
    throw new AppError("posting_failed", result.error, {
      postingCode: result.code,
      ...result.meta,
    });
  }

  await writeAudit(
    {
      organizationId,
      ...auditFields(actor),
      event: "ap.bill.posted",
      entityType: "ap_bill",
      entityId: bill.id,
      metadata: {
        billNumber: bill.billNumber,
        journalId: result.journalId,
        totalAmount: toDbMoney(total),
      },
    },
    tx
  );

  return { journalId: result.journalId, journalNumber: result.journalNumber };
}

/**
 * Reverse a posted bill's GL impact. Called on void. Uses reverseJournal,
 * which creates a new JE swapping debits and credits.
 */
export async function voidBillFromGl(
  ctx: Ctx,
  bill: ApBill,
  reason: string
): Promise<{ journalId: string }> {
  const { actor, tx } = ctx;
  if (!bill.glJournalId) {
    throw new AppError("invalid_state", "Bill has no posted GL journal to reverse.");
  }

  const result = await reverseJournal(
    bill.glJournalId,
    {
      actorId: actor.userId,
      actor,
      organizationId: actor.organizationId,
      description: `Void of bill ${bill.billNumber} — ${reason}`,
    },
    tx
  );

  if (!result.ok) {
    throw new AppError("posting_failed", `GL reversal failed: ${result.error}`, {
      postingCode: result.code,
    });
  }

  await writeAudit(
    {
      organizationId: actor.organizationId,
      ...auditFields(actor),
      event: "ap.bill.voided",
      entityType: "ap_bill",
      entityId: bill.id,
      metadata: {
        billNumber: bill.billNumber,
        reason,
        reversalJournalId: result.journalId,
      },
    },
    tx
  );

  return { journalId: result.journalId };
}
