import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  agents,
  apBills,
  apPayments,
  arInvoices,
  arPayments,
  bankTransactions,
  creditMemos,
  customers,
  refundReceipts,
  salesReceipts,
  glJournals,
  glLines,
  vendors,
} from "@/lib/db/schema";
import { requirePermission, type Ctx } from "@/lib/actor";

/**
 * THE REVIEW QUEUE — everything waiting on a human:
 *   - drafts an agent created (invoices, payments, sales receipts, credit
 *     memos, refunds, bills, journal entries, bank transactions)
 *   - bills pending approval, whoever submitted them
 *
 * Agents in draft mode end every task here; this is where a person turns
 * their work into ledger entries (or sends it back).
 */

export type ReviewItem = {
  type:
    | "invoice"
    | "customer_payment"
    | "sales_receipt"
    | "credit_memo"
    | "refund_receipt"
    | "bill"
    | "bill_payment"
    | "journal_entry"
    | "bank_transaction";
  id: string;
  number: string;
  party: string | null;
  date: string;
  amount: string;
  currency: string;
  status: string;
  reason: "agent_draft" | "awaiting_approval";
  agentId: string | null;
  agentName: string | null;
  createdAt: Date;
  href: string;
};

export async function listReviewQueue(ctx: Ctx): Promise<ReviewItem[]> {
  requirePermission(ctx.actor, "read", "viewer", "read the review queue");
  const org = ctx.actor.organizationId;
  const tx = ctx.tx;

  const [invoices, custPayments, bills, billPayments, journals, bankTxns, receipts, memos, refunds] = await Promise.all([
    tx
      .select({ d: arInvoices, party: customers.name, agentName: agents.name })
      .from(arInvoices)
      .innerJoin(customers, eq(customers.id, arInvoices.customerId))
      .leftJoin(agents, eq(agents.id, arInvoices.createdByAgentId))
      .where(
        and(
          eq(arInvoices.organizationId, org),
          eq(arInvoices.status, "draft"),
          isNotNull(arInvoices.createdByAgentId)
        )
      )
      .orderBy(desc(arInvoices.createdAt)),
    tx
      .select({ d: arPayments, party: customers.name, agentName: agents.name })
      .from(arPayments)
      .innerJoin(customers, eq(customers.id, arPayments.customerId))
      .leftJoin(agents, eq(agents.id, arPayments.createdByAgentId))
      .where(
        and(
          eq(arPayments.organizationId, org),
          eq(arPayments.status, "draft"),
          isNotNull(arPayments.createdByAgentId)
        )
      )
      .orderBy(desc(arPayments.createdAt)),
    tx
      .select({ d: apBills, party: vendors.name, agentName: agents.name })
      .from(apBills)
      .innerJoin(vendors, eq(vendors.id, apBills.vendorId))
      .leftJoin(agents, eq(agents.id, apBills.createdByAgentId))
      .where(
        and(
          eq(apBills.organizationId, org),
          sql`(${apBills.status} = 'pending_approval'
               OR (${apBills.status} IN ('draft', 'approved') AND ${apBills.createdByAgentId} IS NOT NULL))`
        )
      )
      .orderBy(desc(apBills.createdAt)),
    tx
      .select({ d: apPayments, party: vendors.name, agentName: agents.name })
      .from(apPayments)
      .innerJoin(vendors, eq(vendors.id, apPayments.vendorId))
      .leftJoin(agents, eq(agents.id, apPayments.createdByAgentId))
      .where(
        and(
          eq(apPayments.organizationId, org),
          eq(apPayments.status, "draft"),
          isNotNull(apPayments.createdByAgentId)
        )
      )
      .orderBy(desc(apPayments.createdAt)),
    tx
      .select({ d: glJournals, agentName: agents.name })
      .from(glJournals)
      .leftJoin(agents, eq(agents.id, glJournals.createdByAgentId))
      .where(
        and(
          eq(glJournals.organizationId, org),
          inArray(glJournals.status, ["draft", "pending_approval"]),
          eq(glJournals.source, "manual"),
          isNotNull(glJournals.createdByAgentId)
        )
      )
      .orderBy(desc(glJournals.createdAt)),
    tx
      .select({
        d: bankTransactions,
        party: sql<string | null>`COALESCE(${vendors.name}, ${customers.name}, ${bankTransactions.payeeName})`,
        agentName: agents.name,
      })
      .from(bankTransactions)
      .leftJoin(vendors, eq(vendors.id, bankTransactions.vendorId))
      .leftJoin(customers, eq(customers.id, bankTransactions.customerId))
      .leftJoin(agents, eq(agents.id, bankTransactions.createdByAgentId))
      .where(
        and(
          eq(bankTransactions.organizationId, org),
          eq(bankTransactions.status, "draft"),
          isNotNull(bankTransactions.createdByAgentId)
        )
      )
      .orderBy(desc(bankTransactions.createdAt)),
    tx
      .select({ d: salesReceipts, party: customers.name, agentName: agents.name })
      .from(salesReceipts)
      .leftJoin(customers, eq(customers.id, salesReceipts.customerId))
      .leftJoin(agents, eq(agents.id, salesReceipts.createdByAgentId))
      .where(and(eq(salesReceipts.organizationId, org), eq(salesReceipts.status, "draft"), isNotNull(salesReceipts.createdByAgentId)))
      .orderBy(desc(salesReceipts.createdAt)),
    tx
      .select({ d: creditMemos, party: customers.name, agentName: agents.name })
      .from(creditMemos)
      .innerJoin(customers, eq(customers.id, creditMemos.customerId))
      .leftJoin(agents, eq(agents.id, creditMemos.createdByAgentId))
      .where(and(eq(creditMemos.organizationId, org), eq(creditMemos.status, "draft"), isNotNull(creditMemos.createdByAgentId)))
      .orderBy(desc(creditMemos.createdAt)),
    tx
      .select({ d: refundReceipts, party: customers.name, agentName: agents.name })
      .from(refundReceipts)
      .innerJoin(customers, eq(customers.id, refundReceipts.customerId))
      .leftJoin(agents, eq(agents.id, refundReceipts.createdByAgentId))
      .where(and(eq(refundReceipts.organizationId, org), eq(refundReceipts.status, "draft"), isNotNull(refundReceipts.createdByAgentId)))
      .orderBy(desc(refundReceipts.createdAt)),
  ]);

  const journalTotals = journals.length
    ? await tx
        .select({
          journalId: glLines.journalId,
          total: sql<string>`SUM(${glLines.debit})::text`,
        })
        .from(glLines)
        .where(inArray(glLines.journalId, journals.map((j) => j.d.id)))
        .groupBy(glLines.journalId)
    : [];
  const totalByJournal = new Map(journalTotals.map((t) => [t.journalId, t.total]));

  const items: ReviewItem[] = [
    ...invoices.map(({ d, party, agentName }) => ({
      type: "invoice" as const,
      id: d.id,
      number: d.invoiceNumber,
      party,
      date: d.invoiceDate,
      amount: d.totalAmount,
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/ar/invoices/${d.id}`,
    })),
    ...custPayments.map(({ d, party, agentName }) => ({
      type: "customer_payment" as const,
      id: d.id,
      number: d.paymentNumber,
      party,
      date: d.paymentDate,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/ar/payments/${d.id}`,
    })),
    ...bills.map(({ d, party, agentName }) => ({
      type: "bill" as const,
      id: d.id,
      number: d.billNumber,
      party,
      date: d.billDate,
      amount: d.totalAmount,
      currency: d.currency,
      status: d.status,
      reason: d.status === "pending_approval" ? ("awaiting_approval" as const) : ("agent_draft" as const),
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/ap/bills/${d.id}`,
    })),
    ...billPayments.map(({ d, party, agentName }) => ({
      type: "bill_payment" as const,
      id: d.id,
      number: d.paymentNumber,
      party,
      date: d.paymentDate,
      amount: d.netAmount,
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/ap/payments/${d.id}`,
    })),
    ...journals.map(({ d, agentName }) => ({
      type: "journal_entry" as const,
      id: d.id,
      number: d.journalNumber,
      party: null,
      date: d.journalDate,
      amount: totalByJournal.get(d.id) ?? "0",
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/gl/${d.id}`,
    })),
    ...bankTxns.map(({ d, party, agentName }) => ({
      type: "bank_transaction" as const,
      id: d.id,
      number: d.txnNumber,
      party,
      date: d.txnDate,
      amount: d.totalAmount,
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/banking/transactions/${d.id}`,
    })),
    ...receipts.map(({ d, party, agentName }) => ({
      type: "sales_receipt" as const,
      id: d.id,
      number: d.receiptNumber,
      party,
      date: d.receiptDate,
      amount: d.totalAmount,
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/ar/sales-receipts/${d.id}`,
    })),
    ...memos.map(({ d, party, agentName }) => ({
      type: "credit_memo" as const,
      id: d.id,
      number: d.memoNumber,
      party,
      date: d.memoDate,
      amount: d.totalAmount,
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/ar/credit-memos/${d.id}`,
    })),
    ...refunds.map(({ d, party, agentName }) => ({
      type: "refund_receipt" as const,
      id: d.id,
      number: d.refundNumber,
      party,
      date: d.refundDate,
      amount: d.totalAmount,
      currency: d.currency,
      status: d.status,
      reason: "agent_draft" as const,
      agentId: d.createdByAgentId,
      agentName,
      createdAt: d.createdAt,
      href: `/ar/refunds/${d.id}`,
    })),
  ];
  return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
