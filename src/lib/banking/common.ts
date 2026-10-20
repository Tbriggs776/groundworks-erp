import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, glLines, type Account } from "@/lib/db/schema";
import type { Tx } from "@/lib/actor";
import { AppError } from "@/lib/errors";
import { id } from "@/lib/schemas";

/**
 * Shared by the banking services. A "banking account" is an active posting
 * account flagged reconcilable (Checking, Savings, Credit Card) or cash
 * (Petty Cash). Statements import into, and reconcile against, reconcilable
 * accounts only.
 */

export const DimensionTagSchema = z.object({
  dimensionId: id.describe("Dimension (Class, Location, Department, Project)."),
  valueId: id.describe("Value within that dimension."),
});

export async function requireBankingAccount(
  tx: Tx,
  organizationId: string,
  accountId: string,
  opts: { label?: string; reconcilable?: boolean } = {}
): Promise<Account> {
  const label = opts.label ?? "Bank account";
  const [row] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!row) throw new AppError("not_found", `${label} not found.`);
  if (row.accountType !== "posting" || !row.isActive || row.isBlocked) {
    throw new AppError("invalid_input", `${label} ${row.code} (${row.name}) is not an active posting account.`);
  }
  if (opts.reconcilable ? !row.isReconciliation : !row.isReconciliation && !row.isCash) {
    throw new AppError(
      "invalid_input",
      `${label} ${row.code} (${row.name}) isn't a ${opts.reconcilable ? "reconcilable bank or credit card" : "bank, cash, or credit card"} account.`
    );
  }
  return row;
}

/**
 * A ledger line's signed amount on its account, in base currency:
 * debit − credit. Positive is money in for a bank, a payment for a card.
 */
export const lineAmount = sql<string>`(${glLines.debitLocal} - ${glLines.creditLocal})`;
