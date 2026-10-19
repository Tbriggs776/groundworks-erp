import { and, eq, inArray } from "drizzle-orm";
import { accounts, sourceCodes, type Account } from "@/lib/db/schema";
import type { Tx } from "@/lib/actor";
import { AppError } from "@/lib/errors";

/**
 * Lookups every subledger needs when it builds a journal. They throw
 * AppError with setup guidance, because the fix is always "configure the
 * chart of accounts", never "retry".
 */

/** The AR or AP control account (isControl + subcategory). */
export async function controlAccount(
  tx: Tx,
  organizationId: string,
  subcategory: "receivables" | "payables"
): Promise<Pick<Account, "id" | "code">> {
  const [row] = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.isControl, true),
        eq(accounts.subcategory, subcategory)
      )
    )
    .limit(1);
  if (!row) {
    const label = subcategory === "receivables" ? "Accounts Receivable" : "Accounts Payable";
    throw new AppError(
      "invalid_state",
      `No ${label} control account. Flag one ${subcategory} account as a control account in the chart of accounts.`
    );
  }
  return row;
}

/** An account by code, e.g. 4940 Purchase Discounts Earned. */
export async function accountByCode(
  tx: Tx,
  organizationId: string,
  code: string,
  purpose: string
): Promise<Pick<Account, "id" | "code" | "name">> {
  const [row] = await tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.code, code)))
    .limit(1);
  if (!row) {
    throw new AppError(
      "invalid_state",
      `Account ${code} (${purpose}) is missing from the chart of accounts.`
    );
  }
  return row;
}

/** A source code row id, e.g. PJ, SJ, CR, CD. Seeded per org. */
export async function sourceCodeId(
  tx: Tx,
  organizationId: string,
  code: string
): Promise<string> {
  const [row] = await tx
    .select({ id: sourceCodes.id })
    .from(sourceCodes)
    .where(
      and(eq(sourceCodes.organizationId, organizationId), eq(sourceCodes.code, code))
    );
  if (!row) {
    throw new AppError(
      "invalid_state",
      `Source code ${code} is missing for this organization. Re-run org seeding.`
    );
  }
  return row.id;
}

/**
 * Validate that an account exists in this org and can take a posting of
 * this kind. Used when an input names an account directly (bank account on
 * a payment, income account on an item, expense account on a bill line).
 */
export async function requirePostingAccount(
  tx: Tx,
  organizationId: string,
  accountId: string,
  opts: { cash?: boolean; label: string }
): Promise<Account> {
  const [row] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!row) throw new AppError("not_found", `${opts.label} not found.`);
  if (row.accountType !== "posting" || !row.isActive || row.isBlocked) {
    throw new AppError(
      "invalid_input",
      `${opts.label} ${row.code} (${row.name}) is not an active posting account.`
    );
  }
  if (opts.cash && !row.isCash) {
    throw new AppError(
      "invalid_input",
      `${opts.label} ${row.code} (${row.name}) is not a bank / cash account.`
    );
  }
  return row;
}

/**
 * Batch-validate the accounts named on document lines (bill lines, invoice
 * lines, item income/expense accounts): in this org, active posting
 * accounts, and open to direct posting (control accounts belong to their
 * subledger, never to a line).
 */
export async function requireLineAccounts(
  tx: Tx,
  organizationId: string,
  accountIds: string[]
): Promise<Map<string, Account>> {
  const unique = Array.from(new Set(accountIds));
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        inArray(accounts.id, unique)
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    const a = byId.get(id);
    if (!a) {
      throw new AppError("not_found", `Account ${id} not found in this organization.`);
    }
    if (a.accountType !== "posting" || !a.isActive || a.isBlocked || a.isStatistical) {
      throw new AppError(
        "invalid_input",
        `Account ${a.code} (${a.name}) is not an active posting account.`
      );
    }
    if (!a.directPosting || a.isControl) {
      throw new AppError(
        "invalid_input",
        `Account ${a.code} (${a.name}) is a control account and can't be used on a line.`
      );
    }
  }
  return byId;
}
