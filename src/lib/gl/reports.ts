import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/lib/db/client";
import {
  accounts,
  fiscalPeriods,
  fiscalYears,
  glJournals,
  glLines,
  organizations,
  type Account,
} from "@/lib/db/schema";
import { money } from "@/lib/money";
import { inLedger, inLedgerSql } from "./ledger";

/**
 * Financial reports. All amounts in org base currency (debit_local /
 * credit_local on gl_lines). Only posted journals participate.
 *
 * Sign convention internally: net = debit - credit (signed). Positive = net
 * debit; negative = net credit. Each report decides how to present based on
 * the account's `normal_balance`.
 */

// ---------------------------------------------------------------------------
// Trial Balance
// ---------------------------------------------------------------------------

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  category: Account["category"];
  subcategory: Account["subcategory"];
  normalBalance: Account["normalBalance"];
  totalDebit: Decimal; // cumulative through asOf
  totalCredit: Decimal;
  netDebit: Decimal; // = totalDebit - totalCredit (signed)
};

/**
 * Trial Balance as-of a date. Includes all accounts that have any posted
 * activity through the given date, plus all active posting accounts (so the
 * grid is comprehensive even for zero-balance accounts unless filtered).
 *
 * Returns rows sorted by account code. Totals can be derived by summing
 * `totalDebit` and `totalCredit` across rows — they MUST match (this is the
 * fundamental accounting identity and also what proves our posting engine
 * is sound).
 */
export async function getTrialBalance(
  organizationId: string,
  opts: {
    asOfDate: string; // YYYY-MM-DD inclusive
    includeZero?: boolean; // default false
  }
): Promise<TrialBalanceRow[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      category: accounts.category,
      subcategory: accounts.subcategory,
      normalBalance: accounts.normalBalance,
      totalDebit: sql<string>`COALESCE(SUM(CASE WHEN ${inLedgerSql} AND ${glJournals.journalDate} <= ${opts.asOfDate}::date THEN ${glLines.debitLocal} ELSE 0 END), 0)::text`,
      totalCredit: sql<string>`COALESCE(SUM(CASE WHEN ${inLedgerSql} AND ${glJournals.journalDate} <= ${opts.asOfDate}::date THEN ${glLines.creditLocal} ELSE 0 END), 0)::text`,
    })
    .from(accounts)
    .leftJoin(glLines, eq(glLines.accountId, accounts.id))
    .leftJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.accountType, "posting")
      )
    )
    .groupBy(
      accounts.id,
      accounts.code,
      accounts.name,
      accounts.category,
      accounts.subcategory,
      accounts.normalBalance
    )
    .orderBy(asc(accounts.code));

  const includeZero = opts.includeZero ?? false;
  const out: TrialBalanceRow[] = [];
  for (const r of rows) {
    const totalDebit = money(r.totalDebit);
    const totalCredit = money(r.totalCredit);
    const netDebit = totalDebit.minus(totalCredit);
    if (!includeZero && netDebit.isZero() && totalDebit.isZero() && totalCredit.isZero()) {
      continue;
    }
    out.push({
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      category: r.category,
      subcategory: r.subcategory,
      normalBalance: r.normalBalance,
      totalDebit,
      totalCredit,
      netDebit,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Balance Sheet
// ---------------------------------------------------------------------------

/**
 * A single account's entry on a financial statement. `displayAmount` is
 * signed such that a "normal" balance for the account prints positive.
 * e.g. a cash account (debit-normal) with a net debit of $1,000 displays
 * as +1000; an overdraft (credit balance) displays as -1000.
 */
export type StatementRow = {
  accountId: string;
  code: string;
  name: string;
  displayAmount: Decimal;
  normalBalance: Account["normalBalance"];
};

export type StatementSubgroup = {
  subcategory: Account["subcategory"];
  label: string;
  rows: StatementRow[];
  subtotal: Decimal;
};

export type StatementSection = {
  label: string;
  subgroups: StatementSubgroup[];
  total: Decimal;
};

export type BalanceSheet = {
  asOfDate: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  /** Assets − (Liabilities + Equity). Must be zero for a balanced ledger. */
  outOfBalance: Decimal;
};

const ASSET_SUBCATS: Account["subcategory"][] = [
  "cash",
  "receivables",
  "inventory",
  "other_current_asset",
  "fixed_assets",
  "other_asset",
];
const LIABILITY_SUBCATS: Account["subcategory"][] = [
  "payables",
  "accrued_liabilities",
  "other_current_liability",
  "lt_debt",
  "other_liability",
];
const EQUITY_SUBCATS: Account["subcategory"][] = ["equity", "retained_earnings"];

const SUBCAT_LABEL: Record<Account["subcategory"], string> = {
  cash: "Cash",
  receivables: "Receivables",
  inventory: "Inventory",
  other_current_asset: "Other Current Assets",
  fixed_assets: "Fixed Assets",
  other_asset: "Other Assets",
  payables: "Payables",
  accrued_liabilities: "Accrued Liabilities",
  other_current_liability: "Other Current Liabilities",
  lt_debt: "Long-Term Debt",
  other_liability: "Other Liabilities",
  equity: "Equity",
  retained_earnings: "Retained Earnings",
  operating_revenue: "Operating Revenue",
  other_revenue: "Other Revenue",
  cogs_labor: "COGS: Labor",
  cogs_materials: "COGS: Materials",
  cogs_equipment: "COGS: Equipment",
  cogs_subcontractor: "COGS: Subcontractor",
  cogs_other: "COGS: Other",
  operating_expense: "Operating Expenses",
  sga: "SG&A",
  interest: "Interest",
  tax: "Tax",
  other_expense: "Other Expense",
};

const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** First day of the fiscal year holding `asOf`: its fiscal_years row, else the company's start month. */
async function fiscalYearStart(organizationId: string, asOf: string): Promise<string> {
  const [fy] = await db
    .select({ startDate: fiscalYears.startDate })
    .from(fiscalYears)
    .where(and(eq(fiscalYears.organizationId, organizationId), lte(fiscalYears.startDate, asOf), gte(fiscalYears.endDate, asOf)))
    .limit(1);
  if (fy) return fy.startDate;
  const [org] = await db.select({ month: organizations.fiscalYearStartMonth }).from(organizations).where(eq(organizations.id, organizationId));
  const month = org?.month ?? 1;
  const [y, m] = asOf.split("-").map(Number);
  return `${m >= month ? y : y - 1}-${String(month).padStart(2, "0")}-01`;
}

export async function getBalanceSheet(
  organizationId: string,
  asOfDate: string
): Promise<BalanceSheet> {
  const tb = await getTrialBalance(organizationId, {
    asOfDate,
    includeZero: false,
  });

  // Amounts read on the section's side (assets debit, the rest credit), so a
  // contra account (accumulated depreciation, owner's draw) shows negative.
  function buildSection(
    label: string,
    subcats: Account["subcategory"][],
    side: "debit" | "credit"
  ): StatementSection {
    const subgroups: StatementSubgroup[] = [];
    let sectionTotal = money(0);
    for (const sc of subcats) {
      const rows = tb
        .filter((r) => r.subcategory === sc)
        .map<StatementRow>((r) => {
          const display = side === "debit" ? r.netDebit : r.netDebit.neg();
          return {
            accountId: r.accountId,
            code: r.code,
            name: r.name,
            displayAmount: display,
            normalBalance: r.normalBalance,
          };
        });
      if (rows.length === 0) continue;
      const subtotal = rows.reduce(
        (acc, r) => acc.plus(r.displayAmount),
        money(0)
      );
      subgroups.push({ subcategory: sc, label: SUBCAT_LABEL[sc], rows, subtotal });
      sectionTotal = sectionTotal.plus(subtotal);
    }
    return { label, subgroups, total: sectionTotal };
  }

  const assets = buildSection("Assets", ASSET_SUBCATS, "debit");
  const liabilities = buildSection("Liabilities", LIABILITY_SUBCATS, "credit");
  const equity = buildSection("Equity", EQUITY_SUBCATS, "credit");

  // Year end has no closing entry (like QBO): P&L accounts are never zeroed,
  // so equity computes them. Net income before this fiscal year shows as
  // prior years' earnings under Retained Earnings; this fiscal year to date
  // as Net Income. Together they keep Assets = Liabilities + Equity.
  const fyStart = await fiscalYearStart(organizationId, asOfDate);
  const [prior, current] = await Promise.all([
    getIncomeStatement(organizationId, { fromDate: "0001-01-01", toDate: dayBefore(fyStart) }),
    getIncomeStatement(organizationId, { fromDate: fyStart, toDate: asOfDate }),
  ]);
  const rows: StatementRow[] = [
    { accountId: "__prior_earnings__", code: "—", name: "Retained Earnings (prior years)", displayAmount: prior.netIncome, normalBalance: "credit" },
    { accountId: "__net_income__", code: "—", name: "Net Income", displayAmount: current.netIncome, normalBalance: "credit" },
  ];
  const computed = rows.filter((r) => !r.displayAmount.isZero());
  if (computed.length > 0) {
    const earnings = computed.reduce((acc, r) => acc.plus(r.displayAmount), money(0));
    const existingRE = equity.subgroups.find((g) => g.subcategory === "retained_earnings");
    if (existingRE) {
      existingRE.rows.push(...computed);
      existingRE.subtotal = existingRE.subtotal.plus(earnings);
    } else {
      equity.subgroups.push({
        subcategory: "retained_earnings",
        label: SUBCAT_LABEL.retained_earnings,
        rows: computed,
        subtotal: earnings,
      });
    }
    equity.total = equity.total.plus(earnings);
  }

  const outOfBalance = assets.total.minus(liabilities.total).minus(equity.total);

  return { asOfDate, assets, liabilities, equity, outOfBalance };
}

// ---------------------------------------------------------------------------
// Income Statement
// ---------------------------------------------------------------------------

export type IncomeStatement = {
  fromDate: string;
  toDate: string;
  revenue: StatementSection;
  cogs: StatementSection;
  grossProfit: Decimal; // revenue.total - cogs.total
  operatingExpenses: StatementSection;
  operatingIncome: Decimal; // grossProfit - operatingExpenses.total
  otherIncomeExpense: StatementSection;
  netIncome: Decimal; // operatingIncome - otherIncomeExpense.total (expenses positive drag)
};

const REVENUE_SUBCATS: Account["subcategory"][] = [
  "operating_revenue",
];
const OTHER_REVENUE_SUBCATS: Account["subcategory"][] = ["other_revenue"];
const COGS_SUBCATS: Account["subcategory"][] = [
  "cogs_labor",
  "cogs_materials",
  "cogs_equipment",
  "cogs_subcontractor",
  "cogs_other",
];
const OPEX_SUBCATS: Account["subcategory"][] = ["operating_expense", "sga"];
const OTHER_EXPENSE_SUBCATS: Account["subcategory"][] = [
  "interest",
  "tax",
  "other_expense",
];

export async function getIncomeStatement(
  organizationId: string,
  opts: { fromDate: string; toDate: string }
): Promise<IncomeStatement> {
  // Period-scoped activity: get debits/credits for each account between
  // fromDate and toDate (inclusive), ledger journals only. The journal join
  // carries the date and status filter, so only lines that found their
  // journal count.
  const rows = await db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      subcategory: accounts.subcategory,
      normalBalance: accounts.normalBalance,
      totalDebit: sql<string>`COALESCE(SUM(${glLines.debitLocal}) FILTER (WHERE ${glJournals.id} IS NOT NULL), 0)::text`,
      totalCredit: sql<string>`COALESCE(SUM(${glLines.creditLocal}) FILTER (WHERE ${glJournals.id} IS NOT NULL), 0)::text`,
    })
    .from(accounts)
    .leftJoin(
      glLines,
      and(
        eq(glLines.accountId, accounts.id),
        eq(glLines.organizationId, organizationId)
      )
    )
    .leftJoin(
      glJournals,
      and(
        eq(glJournals.id, glLines.journalId),
        inLedger(),
        sql`${glJournals.journalDate} BETWEEN ${opts.fromDate}::date AND ${opts.toDate}::date`
      )
    )
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.category, "income_statement"),
        eq(accounts.accountType, "posting")
      )
    )
    .groupBy(
      accounts.id,
      accounts.code,
      accounts.name,
      accounts.subcategory,
      accounts.normalBalance
    )
    .orderBy(asc(accounts.code));

  function section(label: string, subcats: Account["subcategory"][], side: "debit" | "credit"): StatementSection {
    const subgroups: StatementSubgroup[] = [];
    let total = money(0);
    for (const sc of subcats) {
      const rs = rows
        .filter((r) => r.subcategory === sc)
        .map<StatementRow>((r) => {
          const netDebit = money(r.totalDebit).minus(money(r.totalCredit));
          // Revenue reads credit-positive and expenses debit-positive, by
          // section, so a contra account (sales discounts) shows negative.
          const display = side === "debit" ? netDebit : netDebit.neg();
          return {
            accountId: r.accountId,
            code: r.code,
            name: r.name,
            displayAmount: display,
            normalBalance: r.normalBalance,
          };
        })
        .filter((r) => !r.displayAmount.isZero());
      if (rs.length === 0) continue;
      const subtotal = rs.reduce((a, r) => a.plus(r.displayAmount), money(0));
      subgroups.push({ subcategory: sc, label: SUBCAT_LABEL[sc], rows: rs, subtotal });
      total = total.plus(subtotal);
    }
    return { label, subgroups, total };
  }

  const revenue = section("Operating Revenue", REVENUE_SUBCATS, "credit");
  const cogs = section("Cost of Goods Sold", COGS_SUBCATS, "debit");
  const operatingExpenses = section("Operating Expenses", OPEX_SUBCATS, "debit");
  const otherRevenue = section("Other Revenue", OTHER_REVENUE_SUBCATS, "credit");
  const otherExpenses = section("Other Expense", OTHER_EXPENSE_SUBCATS, "debit");

  // Merge other revenue into "other income/expense" section with expenses.
  // Convention: show income as negative expense so the section total nets
  // correctly against operating income.
  const otherIncomeExpense: StatementSection = {
    label: "Other Income / Expense",
    subgroups: [
      ...otherRevenue.subgroups.map<StatementSubgroup>((g) => ({
        ...g,
        rows: g.rows.map((r) => ({
          ...r,
          displayAmount: r.displayAmount.neg(),
        })),
        subtotal: g.subtotal.neg(),
      })),
      ...otherExpenses.subgroups,
    ],
    total: otherExpenses.total.minus(otherRevenue.total),
  };

  const grossProfit = revenue.total.minus(cogs.total);
  const operatingIncome = grossProfit.minus(operatingExpenses.total);
  const netIncome = operatingIncome.minus(otherIncomeExpense.total);

  return {
    fromDate: opts.fromDate,
    toDate: opts.toDate,
    revenue,
    cogs,
    grossProfit,
    operatingExpenses,
    operatingIncome,
    otherIncomeExpense,
    netIncome,
  };
}

// ---------------------------------------------------------------------------
// GL Detail (by account)
// ---------------------------------------------------------------------------

export type GlDetailRow = {
  lineId: string;
  journalId: string;
  journalNumber: string;
  journalDate: string;
  periodCode: string;
  description: string;
  memo: string | null;
  debit: Decimal;
  credit: Decimal;
  runningBalance: Decimal; // signed; positive = net debit
};

/**
 * Every posted line for an account in a date range, ordered chronologically,
 * with running net-debit balance. Caller can flip the sign for credit-normal
 * accounts when displaying.
 */
export async function getGlDetail(
  organizationId: string,
  opts: {
    accountId: string;
    fromDate?: string;
    toDate?: string;
  }
): Promise<{ opening: Decimal; rows: GlDetailRow[] }> {
  const rangeEnd = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const rangeStart = opts.fromDate;

  // Opening = activity before rangeStart (if any)
  let opening = money(0);
  if (rangeStart) {
    const [o] = await db
      .select({
        debit: sql<string>`COALESCE(SUM(${glLines.debitLocal}), 0)::text`,
        credit: sql<string>`COALESCE(SUM(${glLines.creditLocal}), 0)::text`,
      })
      .from(glLines)
      .innerJoin(
        glJournals,
        and(
          eq(glJournals.id, glLines.journalId),
          inLedger()
        )
      )
      .where(
        and(
          eq(glLines.organizationId, organizationId),
          eq(glLines.accountId, opts.accountId),
          sql`${glJournals.journalDate} < ${rangeStart}::date`
        )
      );
    opening = money(o?.debit ?? "0").minus(money(o?.credit ?? "0"));
  }

  const detailRows = await db
    .select({
      lineId: glLines.id,
      journalId: glJournals.id,
      journalNumber: glJournals.journalNumber,
      journalDate: glJournals.journalDate,
      description: glJournals.description,
      periodCode: fiscalPeriods.periodCode,
      memo: glLines.memo,
      debit: glLines.debitLocal,
      credit: glLines.creditLocal,
    })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, glJournals.periodId))
    .where(
      and(
        eq(glLines.organizationId, organizationId),
        eq(glLines.accountId, opts.accountId),
        inLedger(),
        rangeStart
          ? sql`${glJournals.journalDate} >= ${rangeStart}::date`
          : sql`TRUE`,
        sql`${glJournals.journalDate} <= ${rangeEnd}::date`
      )
    )
    .orderBy(asc(glJournals.journalDate), asc(glJournals.journalNumber), asc(glLines.lineNumber));

  let running = opening;
  const rows: GlDetailRow[] = detailRows.map((r) => {
    const debit = money(r.debit);
    const credit = money(r.credit);
    running = running.plus(debit).minus(credit);
    return {
      lineId: r.lineId,
      journalId: r.journalId,
      journalNumber: r.journalNumber,
      journalDate: r.journalDate,
      periodCode: r.periodCode,
      description: r.description,
      memo: r.memo,
      debit,
      credit,
      runningBalance: running,
    };
  });

  return { opening, rows };
}
