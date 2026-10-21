import { and, eq, inArray, sql } from "drizzle-orm";
import { accounts, numberSeries, qboIdMap } from "@/lib/db/schema";
import type { Kit, Step } from "./kit";

/**
 * Last touches once the history is in: accounts QuickBooks had inactive
 * become inactive (they stayed open while their history posted), and
 * customer-facing numbers continue where QuickBooks left off.
 */

const SERIES = [
  { code: "INV", what: "Invoice", table: "ar_invoices", column: "invoice_number" },
  { code: "SR", what: "Sales receipt", table: "sales_receipts", column: "receipt_number" },
  { code: "CM", what: "Credit memo", table: "credit_memos", column: "memo_number" },
  { code: "RR", what: "Refund receipt", table: "refund_receipts", column: "refund_number" },
] as const;

const MAX_INT = 2_147_483_647;

export const finishStep: Step = {
  key: "finish",
  label: "Finishing up",
  async run(kit: Kit) {
    const inactive = await kit.ctx.tx
      .select({ id: qboIdMap.localId })
      .from(qboIdMap)
      .where(and(eq(qboIdMap.organizationId, kit.org), eq(qboIdMap.entity, "Account"), eq(qboIdMap.value, "inactive")));
    const ids = inactive.map((r) => r.id).filter((x): x is string => Boolean(x));
    if (ids.length > 0) {
      await kit.ctx.tx
        .update(accounts)
        .set({ isActive: false, updatedAt: sql`now()` })
        .where(and(eq(accounts.organizationId, kit.org), inArray(accounts.id, ids)));
    }

    for (const s of SERIES) {
      const rows = await kit.ctx.tx.execute<{ n: string }>(
        sql`SELECT ${sql.identifier(s.column)} AS n FROM ${sql.identifier(s.table)} WHERE organization_id = ${kit.org}`
      );
      if (rows.length === 0) continue;
      const numbers = rows.map((r) => r.n);
      if (!numbers.every((n) => /^\d{1,10}$/.test(n))) {
        kit.note(`${s.what} numbers didn't all come across as plain numbers, so new ones continue in Groundworks' own series.`);
        continue;
      }
      const top = numbers.reduce((a, b) => (Number(b) > Number(a) ? b : a));
      if (Number(top) >= MAX_INT) continue;
      await kit.ctx.tx
        .update(numberSeries)
        .set({ prefix: "", width: top.length, lastUsedNumber: Number(top), updatedAt: sql`now()` })
        .where(and(eq(numberSeries.organizationId, kit.org), eq(numberSeries.code, s.code)));
    }
    kit.count("finish", "imported");
    return { done: true, position: 1 };
  },
};
