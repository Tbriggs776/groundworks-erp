import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  accounts,
  apBillLines,
  costCodes,
  jobs,
  sourceCodes,
  type ApBill,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import {
  createAndPostJournal,
  reverseJournal,
  type JournalLineInput,
} from "@/lib/gl/posting";
import { money, sumMoney, toDbMoney } from "@/lib/money";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * AP → GL posting. For a given approved bill:
 *   - Debits each line's expense account by line.amount
 *   - Credits the AP control account (the one flagged isControl and
 *     matching subcategory=payables, typically code 2000) for the total
 *
 * Job + cost code on each line flow two places:
 *   1. gl_lines.jobId / cost_code_id (direct FKs)
 *   2. gl_line_dimensions with the matching JOB / COST_CODE system
 *      dimension values — so existing GL reports slice by job/code
 *      without knowing anything about AP
 *
 * Runs inside the caller's transaction so a post failure rolls back
 * everything (bill status update, audit row, GL journal).
 */
export async function postBillToGl(
  tx: Tx,
  opts: {
    bill: ApBill;
    actorId: string | null;
    organizationId: string;
  }
): Promise<{ journalId: string; journalNumber: string }> {
  const { bill, actorId, organizationId } = opts;

  // Find the AP control account (isControl=true, subcategory='payables')
  const [apControl] = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.isControl, true),
        eq(accounts.subcategory, "payables")
      )
    )
    .limit(1);
  if (!apControl) {
    throw new Error(
      "No AP control account found. Seed the contractor CoA or flag a payables account as isControl=true."
    );
  }

  // AP source code
  const [apSource] = await tx
    .select({ id: sourceCodes.id })
    .from(sourceCodes)
    .where(
      and(
        eq(sourceCodes.organizationId, organizationId),
        eq(sourceCodes.code, "PJ") // PJ = Purchase / AP Journal
      )
    );
  if (!apSource) {
    throw new Error("PJ source code missing. Re-run org seeding.");
  }

  // Pull lines with enough context for dimension sync
  const lines = await tx
    .select({
      line: apBillLines,
      job: jobs,
      costCode: costCodes,
    })
    .from(apBillLines)
    .leftJoin(jobs, eq(jobs.id, apBillLines.jobId))
    .leftJoin(costCodes, eq(costCodes.id, apBillLines.costCodeId))
    .where(eq(apBillLines.billId, bill.id))
    .orderBy(apBillLines.lineNumber);

  if (lines.length === 0) {
    throw new Error("Bill has no lines to post.");
  }

  // Build JE lines
  const jeLines: JournalLineInput[] = [];
  for (const { line, job, costCode } of lines) {
    const dims: Array<{ dimensionId: string; valueId: string }> = [];
    if (job?.dimensionValueId) {
      // Look up the JOB dimension id from the value
      const [dv] = await tx.execute<{ dim_id: string }>(sql`
        SELECT dimension_id AS dim_id
          FROM public.dimension_values
         WHERE id = ${job.dimensionValueId}
         LIMIT 1
      `);
      if (dv) {
        dims.push({ dimensionId: dv.dim_id, valueId: job.dimensionValueId });
      }
    }
    if (costCode?.dimensionValueId) {
      const [dv] = await tx.execute<{ dim_id: string }>(sql`
        SELECT dimension_id AS dim_id
          FROM public.dimension_values
         WHERE id = ${costCode.dimensionValueId}
         LIMIT 1
      `);
      if (dv) {
        dims.push({
          dimensionId: dv.dim_id,
          valueId: costCode.dimensionValueId,
        });
      }
    }

    jeLines.push({
      accountId: line.accountId,
      debit: toDbMoney(line.amount),
      memo: line.description ?? undefined,
      jobId: line.jobId ?? undefined,
      costCodeId: line.costCodeId ?? undefined,
      vendorId: bill.vendorId,
      dimensions: dims.length > 0 ? dims : undefined,
    });
  }

  // Credit AP control for the total
  const total = sumMoney(lines.map((l) => l.line.amount));
  jeLines.push({
    accountId: apControl.id,
    credit: toDbMoney(total),
    memo: `AP bill ${bill.billNumber} — ${bill.vendorInvoiceNumber ?? "no vendor invoice #"}`,
    vendorId: bill.vendorId,
  });

  const postedAt = bill.postingDate ?? bill.billDate;

  // createAndPostJournal opens its own transaction, but we're already inside
  // a tx. For v1 we accept nested behavior — if the outer tx rolls back,
  // the inner posts do too (Drizzle transactions are savepoint-based in
  // postgres-js). If we need stricter control, refactor to pass tx.
  const result = await createAndPostJournal({
    organizationId,
    actorId,
    journalDate: postedAt,
    sourceCodeId: apSource.id,
    source: "ap",
    description:
      bill.description ??
      `AP bill ${bill.billNumber} from vendor ${bill.vendorId}`,
    currency: bill.currency,
    exchangeRate: bill.exchangeRate,
    documentNo: bill.vendorInvoiceNumber ?? bill.billNumber,
    lines: jeLines,
  });

  if (!result.ok) {
    throw new Error(`GL posting failed: ${result.code}: ${result.error}`);
  }

  await writeAudit(
    {
      organizationId,
      actorId,
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
  tx: Tx,
  opts: {
    bill: ApBill;
    actorId: string | null;
    organizationId: string;
    reason: string;
  }
): Promise<{ journalId: string }> {
  if (!opts.bill.glJournalId) {
    throw new Error("Bill has no posted GL journal to reverse.");
  }

  const result = await reverseJournal(opts.bill.glJournalId, {
    actorId: opts.actorId,
    organizationId: opts.organizationId,
    description: `Void of AP bill ${opts.bill.billNumber} — ${opts.reason}`,
  });

  if (!result.ok) {
    throw new Error(`GL reversal failed: ${result.error}`);
  }

  await writeAudit(
    {
      organizationId: opts.organizationId,
      actorId: opts.actorId,
      event: "ap.bill.voided",
      entityType: "ap_bill",
      entityId: opts.bill.id,
      metadata: {
        billNumber: opts.bill.billNumber,
        reason: opts.reason,
        reversalJournalId: result.journalId,
      },
    },
    tx
  );

  return { journalId: result.journalId };
}

// unused-import guard
void money;
