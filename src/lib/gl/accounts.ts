import { and, asc, eq, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { format } from "date-fns";
import { z } from "zod";
import {
  accountCategory,
  accountSubcategory,
  accounts,
  glJournals,
  glLines,
  normalBalance,
  type Account,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { notFound, rethrowUnique } from "@/lib/errors";
import { money, toDbMoney } from "@/lib/money";
import { flag, id, isoDate, likePattern, optionalText } from "@/lib/schemas";
import { inLedger } from "./ledger";

/**
 * CHART OF ACCOUNTS as a service. Balances are signed in the account's
 * normal direction: a positive balance on Checking (debit-normal) is money
 * in the bank; a positive balance on Sales (credit-normal) is revenue.
 */

export const ListAccountsSchema = z.object({
  q: z.string().trim().optional().describe("Search code or name."),
  category: z.enum(accountCategory.enumValues).optional(),
  subcategory: z.enum(accountSubcategory.enumValues).optional(),
  cashOnly: flag.optional().describe("Only bank / cash accounts."),
  includeInactive: flag.optional(),
  withBalances: flag.optional().describe("Include each account's balance as of `asOf`."),
  asOf: isoDate.optional().describe("Balance date when withBalances is set. Defaults to today."),
});

export const CreateAccountSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  description: optionalText(500),
  subcategory: z.enum(accountSubcategory.enumValues).describe(
    "Drives the category and normal balance, e.g. cash, operating_expense, operating_revenue."
  ),
  normalBalance: z.enum(normalBalance.enumValues).optional().describe("Defaults from the subcategory."),
  isCash: flag.optional().describe("Bank / cash account (can receive deposits and pay bills)."),
});
export type CreateAccountInput = z.input<typeof CreateAccountSchema>;

const BALANCE_SHEET = new Set([
  "cash", "receivables", "inventory", "other_current_asset", "fixed_assets", "other_asset",
  "payables", "accrued_liabilities", "other_current_liability", "lt_debt", "other_liability",
  "equity", "retained_earnings",
]);
const CREDIT_NORMAL = new Set([
  "payables", "accrued_liabilities", "other_current_liability", "lt_debt", "other_liability",
  "equity", "retained_earnings", "operating_revenue", "other_revenue",
]);

export type AccountWithBalance = Account & { balance?: string };

async function balances(ctx: Ctx, asOf: string): Promise<Map<string, string>> {
  const rows = await ctx.tx
    .select({
      accountId: glLines.accountId,
      debit: sql<string>`COALESCE(SUM(${glLines.debitLocal}), 0)::text`,
      credit: sql<string>`COALESCE(SUM(${glLines.creditLocal}), 0)::text`,
    })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .where(
      and(
        eq(glLines.organizationId, ctx.actor.organizationId),
        inLedger(),
        lte(glJournals.journalDate, asOf)
      )
    )
    .groupBy(glLines.accountId);
  return new Map(rows.map((r) => [r.accountId, money(r.debit).minus(money(r.credit)).toFixed(4)]));
}

function signed(account: Account, netDebit: string | undefined): string {
  const n = money(netDebit ?? "0");
  return toDbMoney(account.normalBalance === "debit" ? n : n.negated());
}

export async function listAccounts(
  ctx: Ctx,
  input: z.input<typeof ListAccountsSchema> = {}
): Promise<AccountWithBalance[]> {
  requirePermission(ctx.actor, "read", "viewer", "list accounts");
  const f = ListAccountsSchema.parse(input);
  const rows = await ctx.tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, ctx.actor.organizationId),
        isNull(accounts.deletedAt),
        f.includeInactive ? undefined : eq(accounts.isActive, true),
        f.category ? eq(accounts.category, f.category) : undefined,
        f.subcategory ? eq(accounts.subcategory, f.subcategory) : undefined,
        f.cashOnly ? eq(accounts.isCash, true) : undefined,
        f.q
          ? or(ilike(accounts.code, likePattern(f.q)), ilike(accounts.name, likePattern(f.q)))
          : undefined
      )
    )
    .orderBy(asc(accounts.code));
  if (!f.withBalances) return rows;
  const b = await balances(ctx, f.asOf ?? format(new Date(), "yyyy-MM-dd"));
  return rows.map((a) => ({ ...a, balance: signed(a, b.get(a.id)) }));
}

export async function getAccount(
  ctx: Ctx,
  input: { id: string; asOf?: string }
): Promise<Account & { balance: string; asOf: string }> {
  requirePermission(ctx.actor, "read", "viewer", "view accounts");
  const accountId = id.parse(input.id);
  const asOf = isoDate.optional().parse(input.asOf) ?? format(new Date(), "yyyy-MM-dd");
  const [row] = await ctx.tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, ctx.actor.organizationId)));
  if (!row) throw notFound("Account");
  const b = await balances(ctx, asOf);
  return { ...row, balance: signed(row, b.get(row.id)), asOf };
}

export async function createAccount(ctx: Ctx, input: CreateAccountInput): Promise<Account> {
  requirePermission(ctx.actor, "write", "accountant", "create accounts");
  const d = CreateAccountSchema.parse(input);
  let row: Account;
  try {
    [row] = await ctx.tx
      .insert(accounts)
      .values({
        organizationId: ctx.actor.organizationId,
        code: d.code,
        name: d.name,
        description: d.description,
        subcategory: d.subcategory,
        category: BALANCE_SHEET.has(d.subcategory) ? "balance_sheet" : "income_statement",
        normalBalance: d.normalBalance ?? (CREDIT_NORMAL.has(d.subcategory) ? "credit" : "debit"),
        isCash: d.isCash ?? d.subcategory === "cash",
        isReconciliation: d.isCash ?? d.subcategory === "cash",
      })
      .returning();
  } catch (err) {
    rethrowUnique(err, `Account code ${d.code} is already in use.`);
  }
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "gl.account.created",
      entityType: "account",
      entityId: row.id,
      metadata: { code: row.code, name: row.name, subcategory: row.subcategory },
    },
    ctx.tx
  );
  return row;
}
