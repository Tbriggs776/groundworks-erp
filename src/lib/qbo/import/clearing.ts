import { addDays, format } from "date-fns";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  apPayments,
  arPayments,
  bankTransactions,
  glJournals,
  glLineClearings,
  glLines,
  qboIdMap,
  reconciliations,
  refundReceipts,
  salesReceipts,
} from "@/lib/db/schema";
import { auditFields } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { money, toDbMoney } from "@/lib/money";
import type { Kit, Step } from "./kit";

/**
 * Cleared and reconciled marks, as QuickBooks has them, for every bank and
 * card account: QuickBooks' transaction list filtered to each status names
 * the transactions, and their ledger lines on that account get the mark.
 * Reconciled lines go into one completed reconciliation per account
 * ("Reconciled in QuickBooks"), so the next reconciliation here starts
 * where QuickBooks' last one ended.
 */

type Cell = { value?: string; id?: string };
type ReportRow = { ColData?: Cell[]; Rows?: { Row?: ReportRow[] } };
type Report = {
  Columns?: { Column?: Array<{ ColTitle?: string; MetaData?: Array<{ Name?: string; Value?: string }> }> };
  Rows?: { Row?: ReportRow[] };
};

/** Report transaction types, as the import's entities. */
const ENTITIES: Record<string, string[]> = {
  Check: ["Purchase"],
  Expense: ["Purchase"],
  "Cash Expense": ["Purchase"],
  "Credit Card Expense": ["Purchase"],
  "Credit Card Credit": ["Purchase"],
  "Bill Payment (Check)": ["BillPayment"],
  "Bill Payment (Credit Card)": ["BillPayment"],
  "Bill Payment": ["BillPayment"],
  Deposit: ["Deposit"],
  Payment: ["Payment"],
  "Receive Payment": ["Payment"],
  "Sales Receipt": ["SalesReceipt"],
  Refund: ["RefundReceipt"],
  "Refund Receipt": ["RefundReceipt"],
  Transfer: ["Transfer"],
  "Credit Card Payment": ["Transfer"],
  "Journal Entry": ["JournalEntry"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL = ["Purchase", "BillPayment", "Deposit", "Payment", "SalesReceipt", "RefundReceipt", "Transfer", "JournalEntry"];

/** (transaction type, QuickBooks id) for every data row. */
function transactions(report: Report): Array<{ type: string; id: string }> {
  const cols = report.Columns?.Column ?? [];
  let at = cols.findIndex((c) => c.MetaData?.some((m) => m.Name === "ColKey" && m.Value === "txn_type"));
  if (at < 0) at = cols.findIndex((c) => /transaction type/i.test(c.ColTitle ?? ""));
  const out: Array<{ type: string; id: string }> = [];
  const walk = (rows: ReportRow[] | undefined) => {
    for (const r of rows ?? []) {
      const cell = at >= 0 ? r.ColData?.[at] : undefined;
      if (cell?.id && cell.value) out.push({ type: cell.value, id: cell.id });
      walk(r.Rows?.Row);
    }
  };
  walk(report.Rows?.Row);
  return out;
}

/** The ledger journals an imported transaction posted. */
async function journalsOf(kit: Kit, entity: string, localId: string, value: string | null): Promise<string[]> {
  const tx = kit.ctx.tx;
  const one = async (q: Promise<Array<{ j: string | null }>>) => (await q).map((r) => r.j).filter((j): j is string => Boolean(j));
  switch (entity) {
    case "JournalEntry":
      return [localId];
    case "Purchase":
    case "Deposit":
    case "Transfer":
      return one(tx.select({ j: bankTransactions.glJournalId }).from(bankTransactions).where(eq(bankTransactions.id, localId)));
    case "BillPayment":
      return [
        ...(await one(tx.select({ j: apPayments.glJournalId }).from(apPayments).where(eq(apPayments.id, localId)))),
        ...(value && UUID.test(value) ? await one(tx.select({ j: bankTransactions.glJournalId }).from(bankTransactions).where(eq(bankTransactions.id, value))) : []),
      ];
    case "Payment":
      return one(tx.select({ j: arPayments.glJournalId }).from(arPayments).where(eq(arPayments.id, localId)));
    case "SalesReceipt":
      return one(tx.select({ j: salesReceipts.glJournalId }).from(salesReceipts).where(eq(salesReceipts.id, localId)));
    case "RefundReceipt":
      return one(tx.select({ j: refundReceipts.glJournalId }).from(refundReceipts).where(eq(refundReceipts.id, localId)));
    default:
      return [];
  }
}

async function journalsFor(kit: Kit, t: { type: string; id: string }): Promise<string[]> {
  for (const entity of ENTITIES[t.type] ?? ALL) {
    const m = await kit.mapped(entity, t.id);
    if (m?.localId) return journalsOf(kit, entity, m.localId, m.value);
    // A bill payment with nothing applied is only its check against Accounts Payable.
    if (entity === "BillPayment" && m?.value && UUID.test(m.value)) {
      return (await kit.ctx.tx.select({ j: bankTransactions.glJournalId }).from(bankTransactions).where(eq(bankTransactions.id, m.value)))
        .map((r) => r.j)
        .filter((j): j is string => Boolean(j));
    }
  }
  return [];
}

export const clearingStep: Step = {
  key: "cleared",
  label: "Cleared and reconciled",
  async run(kit, position) {
    // Bank and card accounts that came from QuickBooks, in a stable order.
    const accts = await kit.ctx.tx
      .select({ qboId: qboIdMap.qboId, id: accounts.id, normal: accounts.normalBalance, name: accounts.name })
      .from(qboIdMap)
      .innerJoin(accounts, eq(accounts.id, qboIdMap.localId))
      .where(and(eq(qboIdMap.organizationId, kit.org), eq(qboIdMap.entity, "Account"), eq(accounts.isReconciliation, true)))
      .orderBy(accounts.code);
    const end = format(addDays(new Date(), 400), "yyyy-MM-dd");
    for (let i = position - 1; i < accts.length; i++) {
      if (kit.timeUp()) return { done: false, position: i + 1 };
      const a = accts[i];
      let missing = 0;
      for (const status of ["Reconciled", "Cleared"] as const) {
        const report = await kit.client.report<Report>("TransactionList", {
          account: a.qboId,
          cleared: status,
          start_date: "1990-01-01",
          end_date: end,
          columns: "tx_date,txn_type,doc_num",
        });
        for (const t of transactions(report)) {
          const journals = await journalsFor(kit, t);
          if (journals.length === 0) {
            missing += 1;
            continue;
          }
          const lines = await kit.ctx.tx
            .select({ id: glLines.id })
            .from(glLines)
            .where(and(inArray(glLines.journalId, journals), eq(glLines.accountId, a.id)));
          if (lines.length === 0) continue;
          await kit.ctx.tx
            .insert(glLineClearings)
            .values(
              lines.map((l) => ({
                glLineId: l.id,
                organizationId: kit.org,
                accountId: a.id,
                status: status === "Reconciled" ? ("reconciled" as const) : ("cleared" as const),
                clearedBy: kit.ctx.actor.userId,
              }))
            )
            .onConflictDoNothing();
        }
      }
      await reconciliationFor(kit, a);
      if (missing > 0) {
        kit.note(
          missing === 1
            ? `${a.name}: 1 cleared or reconciled QuickBooks transaction isn't here, so it stays unmarked.`
            : `${a.name}: ${missing} cleared or reconciled QuickBooks transactions aren't here, so they stay unmarked.`
        );
      }
      kit.count("cleared", "imported");
    }
    return { done: true, position: 1 };
  },
};

/** One completed reconciliation holding everything QuickBooks reconciled on the account. */
async function reconciliationFor(kit: Kit, a: { id: string; normal: string; name: string }) {
  const [sum] = await kit.ctx.tx
    .select({
      total: sql<string>`coalesce(sum(${glLines.debitLocal} - ${glLines.creditLocal}), 0)::text`,
      count: sql<number>`count(*)::int`,
      last: sql<string | null>`max(${glJournals.journalDate})::text`,
    })
    .from(glLineClearings)
    .innerJoin(glLines, eq(glLines.id, glLineClearings.glLineId))
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .where(and(eq(glLineClearings.accountId, a.id), eq(glLineClearings.status, "reconciled"), sql`${glLineClearings.reconciliationId} IS NULL`));
  if (!sum.count || !sum.last) return;
  const balance = toDbMoney(money(sum.total).times(a.normal === "credit" ? -1 : 1));
  const [rec] = await kit.ctx.tx
    .insert(reconciliations)
    .values({
      organizationId: kit.org,
      accountId: a.id,
      statementEndDate: sum.last,
      statementEndingBalance: balance,
      beginningBalance: "0",
      clearedBalance: balance,
      clearedCount: sum.count,
      status: "completed",
      startedBy: kit.ctx.actor.userId,
      completedAt: sql`now()`,
      completedBy: kit.ctx.actor.userId,
    })
    .returning();
  await kit.ctx.tx
    .update(glLineClearings)
    .set({ reconciliationId: rec.id })
    .where(and(eq(glLineClearings.accountId, a.id), eq(glLineClearings.status, "reconciled"), sql`${glLineClearings.reconciliationId} IS NULL`));
  await writeAudit(
    {
      organizationId: kit.org,
      ...auditFields(kit.ctx.actor),
      event: "bank.reconciliation.imported",
      entityType: "reconciliation",
      entityId: rec.id,
      metadata: { account: a.name, lines: sum.count, clearedBalance: balance, statementEndDate: sum.last, from: "quickbooks" },
    },
    kit.ctx.tx
  );
}
