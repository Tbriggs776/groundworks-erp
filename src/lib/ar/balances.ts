import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/lib/actor";
import { money } from "@/lib/money";

/**
 * AR BALANCES, one definition for every screen, report, and check.
 *
 *   invoice open      total − posted payments (cash + discount) − credits applied
 *   credit memo left  total − its applications            (open / applied memos)
 *   payment unapplied amount − cash applied to invoices − its credit applications
 *   customer balance  Σ invoices open − Σ credit left − Σ payments unapplied
 *
 * Credit applications are removed when either side is voided, so they need
 * no status filter. Pass `asOf` for the balance on a past date (aging).
 */

const upTo = (col: SQL, asOf?: string) => (asOf ? sql`AND ${col} <= ${asOf}::date` : sql``);

/** Σ settled against the invoice whose id is `invoiceId` (an SQL expression). */
export function invoiceSettledSql(invoiceId: SQL, asOf?: string): SQL<string> {
  return sql<string>`(COALESCE((
      SELECT SUM(a.amount + a.discount_amount)
        FROM ar_payment_applications a
        JOIN ar_payments p ON p.id = a.payment_id
       WHERE a.invoice_id = ${invoiceId} AND p.status = 'posted' ${upTo(sql`p.payment_date`, asOf)}
    ), 0) + COALESCE((
      SELECT SUM(c.amount) FROM ar_credit_applications c
       WHERE c.invoice_id = ${invoiceId} ${upTo(sql`c.applied_on`, asOf)}
    ), 0))`;
}

/** Credit left on the credit memo whose id is `memoId`. */
export function creditMemoLeftSql(memoId: SQL, total: SQL, asOf?: string): SQL<string> {
  return sql<string>`(${total} - COALESCE((
      SELECT SUM(c.amount) FROM ar_credit_applications c
       WHERE c.credit_memo_id = ${memoId} ${upTo(sql`c.applied_on`, asOf)}
    ), 0))`;
}

/** Unapplied amount on the payment whose id is `paymentId`. */
export function paymentUnappliedSql(paymentId: SQL, amount: SQL, asOf?: string): SQL<string> {
  return sql<string>`(${amount} - COALESCE((
      SELECT SUM(a.amount) FROM ar_payment_applications a WHERE a.payment_id = ${paymentId}
    ), 0) - COALESCE((
      SELECT SUM(c.amount) FROM ar_credit_applications c
       WHERE c.payment_id = ${paymentId} ${upTo(sql`c.applied_on`, asOf)}
    ), 0))`;
}

/** Net balance of the customer whose id is `customerId`: owed minus credits. */
export function customerBalanceSql(customerId: SQL): SQL<string> {
  return sql<string>`(COALESCE((
      SELECT SUM(i.total_amount - ${invoiceSettledSql(sql`i.id`)})
        FROM ar_invoices i WHERE i.customer_id = ${customerId} AND i.status IN ('open', 'paid')
    ), 0) - COALESCE((
      SELECT SUM(${creditMemoLeftSql(sql`m.id`, sql`m.total_amount`)})
        FROM credit_memos m WHERE m.customer_id = ${customerId} AND m.status IN ('open', 'applied')
    ), 0) - COALESCE((
      SELECT SUM(${paymentUnappliedSql(sql`p.id`, sql`p.amount`)})
        FROM ar_payments p WHERE p.customer_id = ${customerId} AND p.status = 'posted'
    ), 0))`;
}

export async function invoiceSettled(tx: Tx, invoiceId: string) {
  const [row] = await tx.execute<{ v: string }>(sql`SELECT ${invoiceSettledSql(sql`${invoiceId}::uuid`)}::text AS v`);
  return money(row.v);
}
