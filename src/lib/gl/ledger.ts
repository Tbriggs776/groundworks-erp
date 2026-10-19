import { inArray, sql } from "drizzle-orm";
import { glJournals } from "@/lib/db/schema";

/**
 * Which journals count toward balances. A journal stays in the ledger once
 * posted: reversing it flips its status to `reversed`, but its reversal is
 * a separate posted journal that offsets it. Count both, or a reversal
 * double-counts (the original drops out while its mirror stays in).
 */
export const LEDGER_STATUSES = ["posted", "reversed"] as const;

/** Drizzle predicate: the joined gl_journals row is in the ledger. */
export function inLedger() {
  return inArray(glJournals.status, [...LEDGER_STATUSES]);
}

/** Same predicate as raw SQL, for CASE WHEN expressions. */
export const inLedgerSql = sql`${glJournals.status} IN ('posted', 'reversed')`;
