import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/lib/actor";
import { money } from "@/lib/money";

/**
 * AP BALANCES, one definition for every screen, report, and check.
 *
 *   bill open            total − posted payments (cash + discount) − vendor credits applied
 *   vendor credit left   total − its applications (to bills and refunds)
 *   vendor balance       Σ bills open − Σ credit left
 *
 * Credit applications are removed when either side is voided, so they need
 * no status filter. Pass `asOf` for the balance on a past date (aging).
 */

const upTo = (col: SQL, asOf?: string) => (asOf ? sql`AND ${col} <= ${asOf}::date` : sql``);

/** Σ settled against the bill whose id is `billId` (an SQL expression). */
export function billSettledSql(billId: SQL, asOf?: string): SQL<string> {
  return sql<string>`(COALESCE((
      SELECT SUM(a.applied_amount + a.discount_amount)
        FROM ap_payment_applications a
        JOIN ap_payments p ON p.id = a.payment_id
       WHERE a.bill_id = ${billId} AND p.status = 'posted' ${upTo(sql`p.payment_date`, asOf)}
    ), 0) + COALESCE((
      SELECT SUM(c.amount) FROM ap_credit_applications c
       WHERE c.bill_id = ${billId} ${upTo(sql`c.applied_on`, asOf)}
    ), 0))`;
}

/** Credit left on the vendor credit whose id is `creditId`. */
export function vendorCreditLeftSql(creditId: SQL, total: SQL, asOf?: string): SQL<string> {
  return sql<string>`(${total} - COALESCE((
      SELECT SUM(c.amount) FROM ap_credit_applications c
       WHERE c.vendor_credit_id = ${creditId} ${upTo(sql`c.applied_on`, asOf)}
    ), 0))`;
}

/** Net amount owed to the vendor whose id is `vendorId`: bills open minus unused credits. */
export function vendorBalanceSql(vendorId: SQL): SQL<string> {
  return sql<string>`(COALESCE((
      SELECT SUM(b.total_amount - ${billSettledSql(sql`b.id`)})
        FROM ap_bills b WHERE b.vendor_id = ${vendorId} AND b.status IN ('posted', 'paid')
    ), 0) - COALESCE((
      SELECT SUM(${vendorCreditLeftSql(sql`v.id`, sql`v.total_amount`)})
        FROM vendor_credits v WHERE v.vendor_id = ${vendorId} AND v.status IN ('open', 'applied')
    ), 0))`;
}

export async function billSettled(tx: Tx, billId: string) {
  const [row] = await tx.execute<{ v: string }>(sql`SELECT ${billSettledSql(sql`${billId}::uuid`)}::text AS v`);
  return money(row.v);
}
