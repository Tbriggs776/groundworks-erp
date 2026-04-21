import { and, asc, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/lib/db/client";
import {
  accounts,
  fiscalPeriods,
  glJournals,
  glLines,
  type Account,
} from "@/lib/db/schema";
import { money } from "@/lib/money";

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
      totalDebit: sql<string>`COALESCE(SUM(CASE WHEN ${glJournals.status} = 'posted' AND ${glJournals.journalDate} <= ${opts.asOfDate}::date THEN ${glLines.debitLocal} ELSE 0 END), 0)::text`,
      totalCredit: sql<string>`COALESCE(SUM(CASE WHEN ${glJournals.status} = 'posted' AND ${glJournals.journalDate} <= ${opts.asOfDate}::date THEN ${glLines.creditLocal} ELSE 0 END), 0)::text`,
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
  cogs_labor: "COGS — Labor",
  cogs_materials: "COGS — Materials",
  cogs_equipment: "COGS — Equipment",
  cogs_subcontractor: "COGS — Subcontractor",
  cogs_other: "COGS — Other",
  operating_expense: "Operating Expenses",
  sga: "SG&A",
  interest: "Interest",
  tax: "Tax",
  other_expense: "Other Expense",
};

export async function getBalanceSheet(
  organizationId: string,
  asOfDate: string
): Promise<BalanceSheet> {
  const tb = await getTrialBalance(organizationId, {
    asOfDate,
    includeZero: false,
  });

  function buildSection(
    label: string,
    subcats: Account["subcategory"][]
  ): StatementSection {
    const subgroups: StatementSubgroup[] = [];
    let sectionTotal = money(0);
    for (const sc of subcats) {
      const rows = tb
        .filter((r) => r.subcategory === sc)
        .map<StatementRow>((r) => {
          const display =
            r.normalBalance === "debit" ? r.netDebit : r.netDebit.neg();
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

  const assets = buildSection("Assets", ASSET_SUBCATS);
  const liabilities = buildSection("Liabilities", LIABILITY_SUBCATS);
  const equity = buildSection("Equity", EQUITY_SUBCATS);

  // Current-year P&L accounts roll into equity for a balanced sheet. Until
  // year-end close generates an explicit "Current Year Earnings" entry, we
  // fold the net income into equity here so Assets = L + E still holds.
  const income = await getIncomeStatement(organizationId, {
    fromDate: "0001-01-01",
    toDate: asOfDate,
  });
  if (!income.netIncome.isZero()) {
    const existingRE = equity.subgroups.find(
      (g) => g.subcategory === "retained_earnings"
    );
    const placeholder: StatementRow = {
      accountId: "__unposted_earnings__",
      code: "—",
      name: "Current-Year Earnings (unposted)",
      displayAmount: income.netIncome,
      normalBalance: "credit",
    };
    if (existingRE) {
      existingRE.rows.push(placeholder);
      existingRE.subtotal = existingRE.subtotal.plus(income.netIncome);
    } else {
      equity.subgroups.push({
        subcategory: "retained_earnings",
        label: SUBCAT_LABEL.retained_earnings,
        rows: [placeholder],
        subtotal: income.netIncome,
      });
    }
    equity.total = equity.total.plus(income.netIncome);
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
  // fromDate and toDate (inclusive), posted only.
  const rows = await db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      subcategory: accounts.subcategory,
      normalBalance: accounts.normalBalance,
      totalDebit: sql<string>`COALESCE(SUM(${glLines.debitLocal}), 0)::text`,
      totalCredit: sql<string>`COALESCE(SUM(${glLines.creditLocal}), 0)::text`,
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
        eq(glJournals.status, "posted"),
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

  function section(label: string, subcats: Account["subcategory"][]): StatementSection {
    const subgroups: StatementSubgroup[] = [];
    let total = money(0);
    for (const sc of subcats) {
      const rs = rows
        .filter((r) => r.subcategory === sc)
        .map<StatementRow>((r) => {
          const netDebit = money(r.totalDebit).minus(money(r.totalCredit));
          // For revenue (credit-normal), flip so revenue prints positive.
          // For expenses (debit-normal), leave as-is (positive = expense).
          const display =
            r.normalBalance === "debit" ? netDebit : netDebit.neg();
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

  const revenue = section("Operating Revenue", REVENUE_SUBCATS);
  const cogs = section("Cost of Goods Sold", COGS_SUBCATS);
  const operatingExpenses = section("Operating Expenses", OPEX_SUBCATS);
  const otherRevenue = section("Other Revenue", OTHER_REVENUE_SUBCATS);
  const otherExpenses = section("Other Expense", OTHER_EXPENSE_SUBCATS);

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
          eq(glJournals.status, "posted")
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
        eq(glJournals.status, "posted"),
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
