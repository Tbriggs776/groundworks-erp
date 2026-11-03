import { addDays, format } from "date-fns";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  apPayments,
  arPayments,
  auditLog,
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
  "Credit Card Payment": ["CreditCardPayment", "Transfer"],
  "Journal Entry": ["JournalEntry"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL = ["Purchase", "BillPayment", "Deposit", "Payment", "SalesReceipt", "RefundReceipt", "Transfer", "CreditCardPayment", "JournalEntry"];

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

const CHUNK = 2000;
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** The document table an imported transaction's journal lives on (a journal entry is its own journal). */
const TABLES = { bank: bankTransactions, ap: apPayments, ar: arPayments, sales: salesReceipts, refund: refundReceipts } as const;
type Where = keyof typeof TABLES | "self";
const WHERE: Record<string, Where> = {
  JournalEntry: "self",
  Purchase: "bank",
  Deposit: "bank",
  Transfer: "bank",
  CreditCardPayment: "bank",
  BillPayment: "ap",
  Payment: "ar",
  SalesReceipt: "sales",
  RefundReceipt: "refund",
};

/**
 * The ledger journals of many imported transactions at once (key
 * `type:id`): each one is found in the id map (preloaded), grouped by the
 * table its document lives in, and each table is read once. A bill payment
 * also has its check against Accounts Payable when nothing was applied (a
 * bank transaction, in the map's `value`).
 */
async function journalsForAll(kit: Kit, txns: Array<{ type: string; id: string }>): Promise<Map<string, string[]>> {
  const wants = new Map<Where, Array<{ key: string; localId: string }>>();
  const want = (where: Where, key: string, localId: string) => wants.set(where, [...(wants.get(where) ?? []), { key, localId }]);
  for (const t of txns) {
    const key = `${t.type}:${t.id}`;
    for (const entity of ENTITIES[t.type] ?? ALL) {
      const m = await kit.mapped(entity, t.id);
      const check = entity === "BillPayment" && m?.value && UUID.test(m.value) ? m.value : null;
      if (m?.localId) want(WHERE[entity], key, m.localId);
      if (check) want("bank", key, check);
      if (m?.localId || check) break;
    }
  }
  const journals = new Map<string, string[]>();
  const add = (key: string, j: string | null | undefined) => {
    if (j) journals.set(key, [...(journals.get(key) ?? []), j]);
  };
  for (const [where, list] of wants) {
    if (where === "self") {
      for (const w of list) add(w.key, w.localId);
      continue;
    }
    const table = TABLES[where];
    const byId = new Map<string, string | null>();
    for (const ids of chunks([...new Set(list.map((w) => w.localId))])) {
      for (const r of await kit.ctx.tx.select({ id: table.id, j: table.glJournalId }).from(table).where(inArray(table.id, ids))) byId.set(r.id, r.j);
    }
    for (const w of list) add(w.key, byId.get(w.localId));
  }
  return journals;
}

export const clearingStep: Step = {
  key: "cleared",
  label: "Cleared and reconciled",
  async run(kit, position) {
    // Bank and card accounts that came from QuickBooks, in a stable order.
    const all = await kit.ctx.tx
      .select({ qboId: qboIdMap.qboId, id: accounts.id, normal: accounts.normalBalance, name: accounts.name })
      .from(qboIdMap)
      .innerJoin(accounts, eq(accounts.id, qboIdMap.localId))
      .where(and(eq(qboIdMap.organizationId, kit.org), eq(qboIdMap.entity, "Account"), eq(accounts.isReconciliation, true)))
      .orderBy(accounts.code);
    // An import that stopped partway through this step (it used to go an
    // account a batch) keeps the accounts it finished as they are.
    const accts = all.slice(position - 1);
    if (accts.length === 0) return { done: true, position: 1 };
    for (const e of ALL) await kit.preload(e);
    const end = format(addDays(new Date(), 400), "yyyy-MM-dd");
    const t0 = Date.now();

    // QuickBooks' transaction list, filtered by status, once for the whole
    // company: the report has no documented account filter, so asking per
    // account read the same list again for every account. Reconciled wins
    // over cleared.
    const status = new Map<string, "reconciled" | "cleared">();
    const txns: Array<{ type: string; id: string }> = [];
    for (const s of ["Reconciled", "Cleared"] as const) {
      const report = await kit.client.report<Report>("TransactionList", { cleared: s, start_date: "1990-01-01", end_date: end, columns: "tx_date,txn_type,doc_num" });
      const rows = transactions(report);
      console.log(`[qbo.cleared] ${s}: ${rows.length} transactions (+${Date.now() - t0}ms)`);
      for (const t of rows) {
        const key = `${t.type}:${t.id}`;
        if (status.has(key)) continue;
        status.set(key, s === "Reconciled" ? "reconciled" : "cleared");
        txns.push(t);
      }
    }
    const journals = await journalsForAll(kit, txns);
    const missing = txns.filter((t) => !journals.has(`${t.type}:${t.id}`)).length;
    const journalStatus = new Map<string, "reconciled" | "cleared">();
    for (const [key, js] of journals) for (const j of js) if (journalStatus.get(j) !== "reconciled") journalStatus.set(j, status.get(key)!);

    // Their lines on the bank and card accounts, then the marks, in bulk.
    const acctIds = accts.map((a) => a.id);
    const lines: Array<{ id: string; accountId: string; journalId: string }> = [];
    for (const js of chunks([...journalStatus.keys()])) {
      lines.push(
        ...(await kit.ctx.tx
          .select({ id: glLines.id, accountId: glLines.accountId, journalId: glLines.journalId })
          .from(glLines)
          .where(and(inArray(glLines.journalId, js), inArray(glLines.accountId, acctIds))))
      );
    }
    for (const part of chunks(lines)) {
      await kit.ctx.tx
        .insert(glLineClearings)
        .values(
          part.map((l) => ({
            glLineId: l.id,
            organizationId: kit.org,
            accountId: l.accountId,
            status: journalStatus.get(l.journalId)!,
            clearedBy: kit.ctx.actor.userId,
          }))
        )
        .onConflictDoNothing();
    }
    console.log(`[qbo.cleared] marked ${lines.length} lines on ${accts.length} accounts (+${Date.now() - t0}ms)`);

    // A transaction on two of these accounts (a transfer, a card payment)
    // gets one status from QuickBooks' list, so both sides carry it. Say so.
    const names = new Map(accts.map((a) => [a.id, a.name]));
    const sides = new Map<string, Set<string>>();
    for (const l of lines) sides.set(l.journalId, (sides.get(l.journalId) ?? new Set()).add(l.accountId));
    const pairs = new Map<string, number>();
    for (const accountIds of sides.values()) {
      if (accountIds.size < 2) continue;
      const pair = [...accountIds].map((id) => names.get(id)!).sort().join(" and ");
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
    for (const [pair, n] of pairs) {
      kit.note(
        `${pair}: ${n} ${n === 1 ? "transaction touches" : "transactions touch"} both accounts and came across with QuickBooks' one cleared status on both sides. Check ${n === 1 ? "it" : "them"} in each account's first reconciliation.`
      );
    }
    if (missing > 0) {
      kit.note(
        missing === 1
          ? "1 cleared or reconciled QuickBooks transaction isn't here, so it stays unmarked."
          : `${missing} cleared or reconciled QuickBooks transactions aren't here, so they stay unmarked.`
      );
    }

    for (const a of accts) {
      await reconciliationFor(kit, a);
      kit.count("cleared", "imported");
    }
    return { done: true, position: 1 };
  },
};

/**
 * One completed reconciliation holding everything QuickBooks reconciled on
 * the account. Run again (an import resumed for a step added later), the
 * newly reconciled lines join that same reconciliation and its totals are
 * worked out again, so an account never gets a second imported one.
 */
async function reconciliationFor(kit: Kit, a: { id: string; normal: string; name: string }) {
  const tx = kit.ctx.tx;
  const loose = and(eq(glLineClearings.accountId, a.id), eq(glLineClearings.status, "reconciled"), sql`${glLineClearings.reconciliationId} IS NULL`);
  const totals = async (where: ReturnType<typeof and>) => {
    const [sum] = await tx
      .select({
        total: sql<string>`coalesce(sum(${glLines.debitLocal} - ${glLines.creditLocal}), 0)::text`,
        count: sql<number>`count(*)::int`,
        last: sql<string | null>`max(${glJournals.journalDate})::text`,
      })
      .from(glLineClearings)
      .innerJoin(glLines, eq(glLines.id, glLineClearings.glLineId))
      .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
      .where(where);
    return { ...sum, balance: toDbMoney(money(sum.total).times(a.normal === "credit" ? -1 : 1)) };
  };
  const fresh = await totals(loose);
  if (!fresh.count || !fresh.last) return;

  const [prior] = await tx
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .innerJoin(auditLog, and(eq(auditLog.entityId, reconciliations.id), eq(auditLog.event, "bank.reconciliation.imported")))
    .where(and(eq(reconciliations.organizationId, kit.org), eq(reconciliations.accountId, a.id), eq(reconciliations.status, "completed")))
    .limit(1);
  if (prior) {
    await tx.update(glLineClearings).set({ reconciliationId: prior.id }).where(loose);
    const all = await totals(eq(glLineClearings.reconciliationId, prior.id));
    await tx
      .update(reconciliations)
      .set({ statementEndDate: all.last!, statementEndingBalance: all.balance, clearedBalance: all.balance, clearedCount: all.count, updatedAt: sql`now()` })
      .where(eq(reconciliations.id, prior.id));
    await writeAudit(
      {
        organizationId: kit.org,
        ...auditFields(kit.ctx.actor),
        event: "bank.reconciliation.import_extended",
        entityType: "reconciliation",
        entityId: prior.id,
        metadata: { account: a.name, added: fresh.count, lines: all.count, clearedBalance: all.balance, statementEndDate: all.last, from: "quickbooks" },
      },
      tx
    );
    return;
  }

  const [rec] = await tx
    .insert(reconciliations)
    .values({
      organizationId: kit.org,
      accountId: a.id,
      statementEndDate: fresh.last,
      statementEndingBalance: fresh.balance,
      beginningBalance: "0",
      clearedBalance: fresh.balance,
      clearedCount: fresh.count,
      status: "completed",
      startedBy: kit.ctx.actor.userId,
      completedAt: sql`now()`,
      completedBy: kit.ctx.actor.userId,
    })
    .returning();
  await tx.update(glLineClearings).set({ reconciliationId: rec.id }).where(loose);
  await writeAudit(
    {
      organizationId: kit.org,
      ...auditFields(kit.ctx.actor),
      event: "bank.reconciliation.imported",
      entityType: "reconciliation",
      entityId: rec.id,
      metadata: { account: a.name, lines: fresh.count, clearedBalance: fresh.balance, statementEndDate: fresh.last, from: "quickbooks" },
    },
    tx
  );
}
