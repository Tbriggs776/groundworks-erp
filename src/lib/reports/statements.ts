import Decimal from "decimal.js";
import { addMonths, addYears, format, parseISO, startOfMonth, startOfQuarter, startOfYear } from "date-fns";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, budgets, dimensions, dimensionValues, type Account } from "@/lib/db/schema";
import { requirePermission, type Ctx } from "@/lib/actor";
import { AppError, notFound } from "@/lib/errors";
import { money } from "@/lib/money";
import { id, isoDate } from "@/lib/schemas";
import { fmt2, type ReportRow, type ReportTable } from "./table";

/**
 * Financial statements as report tables: the profit and loss over columns
 * (months, quarters, years, classes or locations, actual against budget)
 * and the statement of cash flows. Everything reads posted and reversed
 * journals (the ledger), in base currency, by journal date.
 *
 * P&L sections follow the income statement: operating revenue, COGS, gross
 * profit, operating expenses, operating income, other revenue, other
 * expense, net income. Revenue and expenses both print positive.
 */

const today = () => format(new Date(), "yyyy-MM-dd");
const yearStart = () => format(startOfYear(new Date()), "yyyy-MM-dd");

const Range = {
  from: isoDate.optional().describe("Start date (inclusive). Defaults to Jan 1 of this year."),
  to: isoDate.optional().describe("End date (inclusive). Defaults to today."),
};

function range(f: { from?: string; to?: string }) {
  const from = f.from ?? yearStart();
  const to = f.to ?? today();
  if (to < from) throw new AppError("invalid_input", "The end date can't be before the start date.");
  return { from, to };
}

function rangeLabel(from: string, to: string) {
  return `${format(parseISO(from), "MMM d, yyyy")} to ${format(parseISO(to), "MMM d, yyyy")}`;
}

type PnlAccount = Pick<Account, "id" | "code" | "name" | "subcategory" | "normalBalance">;

async function pnlAccounts(ctx: Ctx): Promise<PnlAccount[]> {
  return ctx.tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, subcategory: accounts.subcategory, normalBalance: accounts.normalBalance })
    .from(accounts)
    .where(and(eq(accounts.organizationId, ctx.actor.organizationId), eq(accounts.category, "income_statement"), eq(accounts.accountType, "posting")))
    .orderBy(asc(accounts.code));
}

/** Net debit per account per bucket. `bucket` is a SQL expression over j (gl_journals), l (gl_lines), and the optional joins. */
async function netByBucket(
  ctx: Ctx,
  opts: { from: string; to: string; bucket: ReturnType<typeof sql>; joins?: ReturnType<typeof sql>; category: "income_statement" | "balance_sheet" }
): Promise<Map<string, Map<string, Decimal>>> {
  const rows = await ctx.tx.execute<{ account_id: string; bucket: string | null; net: string }>(sql`
    SELECT l.account_id, ${opts.bucket} AS bucket, SUM(l.debit_local - l.credit_local)::text AS net
      FROM gl_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id
      ${opts.joins ?? sql``}
     WHERE l.organization_id = ${ctx.actor.organizationId}
       AND j.status IN ('posted', 'reversed')
       AND j.journal_date BETWEEN ${opts.from}::date AND ${opts.to}::date
       AND a.category = ${opts.category}
     GROUP BY 1, 2
  `);
  const out = new Map<string, Map<string, Decimal>>();
  for (const r of rows) {
    const byBucket = out.get(r.account_id) ?? new Map<string, Decimal>();
    const key = r.bucket ?? "";
    byBucket.set(key, (byBucket.get(key) ?? money(0)).plus(money(r.net)));
    out.set(r.account_id, byBucket);
  }
  return out;
}

const SECTIONS: Array<{ key: string; label: string; total: string; subcats: Account["subcategory"][] }> = [
  { key: "revenue", label: "Operating Revenue", total: "Total Operating Revenue", subcats: ["operating_revenue"] },
  { key: "cogs", label: "Cost of Goods Sold", total: "Total COGS", subcats: ["cogs_labor", "cogs_materials", "cogs_equipment", "cogs_subcontractor", "cogs_other"] },
  { key: "opex", label: "Operating Expenses", total: "Total Operating Expenses", subcats: ["operating_expense", "sga"] },
  { key: "otherRevenue", label: "Other Revenue", total: "Total Other Revenue", subcats: ["other_revenue"] },
  { key: "otherExpense", label: "Other Expense", total: "Total Other Expense", subcats: ["interest", "tax", "other_expense"] },
];

/**
 * P&L rows for any set of columns. `net` holds net debit per account per
 * bucket; display flips credit-normal accounts so revenue prints positive.
 * Returns the rows and the net income per column.
 */
function pnlRows(accts: PnlAccount[], net: Map<string, Map<string, Decimal>>, buckets: string[]): { rows: ReportRow[]; netIncome: Decimal[] } {
  const zero = () => buckets.map(() => money(0));
  const display = (a: PnlAccount, b: string) => {
    const n = net.get(a.id)?.get(b) ?? money(0);
    return a.normalBalance === "debit" ? n : n.neg();
  };
  const rows: ReportRow[] = [];
  const totals: Record<string, Decimal[]> = {};
  for (const s of SECTIONS) {
    const sectionAccounts = accts
      .filter((a) => s.subcats.includes(a.subcategory))
      .map((a) => ({ a, values: buckets.map((b) => display(a, b)) }))
      .filter((x) => x.values.some((v) => !v.isZero()));
    const sum = zero();
    for (const x of sectionAccounts) x.values.forEach((v, i) => (sum[i] = sum[i].plus(v)));
    totals[s.key] = sum;
    if (sectionAccounts.length > 0 || s.key === "revenue" || s.key === "opex") {
      rows.push({ kind: "section", label: s.label, values: buckets.map(() => null) });
      for (const x of sectionAccounts) {
        rows.push({ kind: "account", label: x.a.name, code: x.a.code, accountId: x.a.id, depth: 1, values: x.values.map(fmt2) });
      }
      rows.push({ kind: "subtotal", label: s.total, values: sum.map(fmt2) });
    }
    if (s.key === "cogs") {
      rows.push({ kind: "total", label: "Gross Profit", values: buckets.map((_, i) => fmt2(totals.revenue[i].minus(totals.cogs[i]))) });
    }
    if (s.key === "opex") {
      rows.push({
        kind: "total",
        label: "Operating Income",
        values: buckets.map((_, i) => fmt2(totals.revenue[i].minus(totals.cogs[i]).minus(totals.opex[i]))),
      });
    }
  }
  const netIncome = buckets.map((_, i) =>
    totals.revenue[i].minus(totals.cogs[i]).minus(totals.opex[i]).plus(totals.otherRevenue[i]).minus(totals.otherExpense[i])
  );
  rows.push({ kind: "total", label: "Net Income", values: netIncome.map(fmt2) });
  return { rows, netIncome };
}

/** Add a Total column summing every bucket. */
function withTotal(net: Map<string, Map<string, Decimal>>, buckets: string[]) {
  for (const byBucket of net.values()) {
    byBucket.set("__total", buckets.reduce((acc, b) => acc.plus(byBucket.get(b) ?? money(0)), money(0)));
  }
  return [...buckets, "__total"];
}

// ---------------------------------------------------------------------------
// Profit and loss, single column (the income statement as a table)
// ---------------------------------------------------------------------------

export const ProfitAndLossTableSchema = z.object(Range);

export async function profitAndLossTable(ctx: Ctx, input: z.input<typeof ProfitAndLossTableSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the profit and loss");
  const { from, to } = range(ProfitAndLossTableSchema.parse(input));
  const net = await netByBucket(ctx, { from, to, bucket: sql`'all'`, category: "income_statement" });
  const { rows } = pnlRows(await pnlAccounts(ctx), net, ["all"]);
  return { title: "Profit and Loss", subtitle: rangeLabel(from, to), labelColumn: "Account", columns: ["Total"], rows };
}

// ---------------------------------------------------------------------------
// Profit and loss by month, quarter, or year
// ---------------------------------------------------------------------------

export const ProfitAndLossByPeriodSchema = z.object({
  ...Range,
  period: z.enum(["month", "quarter", "year"]).default("month").describe("Column size."),
});

const MAX_COLUMNS = 36;

export async function profitAndLossByPeriod(ctx: Ctx, input: z.input<typeof ProfitAndLossByPeriodSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the profit and loss");
  const f = ProfitAndLossByPeriodSchema.parse(input);
  const { from, to } = range(f);
  const startOf = f.period === "month" ? startOfMonth : f.period === "quarter" ? startOfQuarter : startOfYear;
  const step = (d: Date) => (f.period === "month" ? addMonths(d, 1) : f.period === "quarter" ? addMonths(d, 3) : addYears(d, 1));
  const label = (d: Date) => (f.period === "month" ? format(d, "MMM yyyy") : f.period === "quarter" ? `Q${Math.floor(d.getMonth() / 3) + 1} ${format(d, "yyyy")}` : format(d, "yyyy"));
  const buckets: string[] = [];
  const labels: string[] = [];
  for (let d = startOf(parseISO(from)); format(d, "yyyy-MM-dd") <= to; d = step(d)) {
    buckets.push(format(d, "yyyy-MM-dd"));
    labels.push(label(d));
    if (buckets.length > MAX_COLUMNS) {
      throw new AppError("invalid_input", `That's more than ${MAX_COLUMNS} ${f.period}s. Pick a shorter range or a bigger period.`);
    }
  }
  const trunc = sql.raw(`'${f.period}'`);
  const net = await netByBucket(ctx, {
    from,
    to,
    bucket: sql`to_char(date_trunc(${trunc}, j.journal_date), 'YYYY-MM-DD')`,
    category: "income_statement",
  });
  const cols = withTotal(net, buckets);
  const { rows } = pnlRows(await pnlAccounts(ctx), net, cols);
  return {
    title: `Profit and Loss by ${f.period === "month" ? "Month" : f.period === "quarter" ? "Quarter" : "Year"}`,
    subtitle: rangeLabel(from, to),
    labelColumn: "Account",
    columns: [...labels, "Total"],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Profit and loss by class or location (a dimension)
// ---------------------------------------------------------------------------

export const ProfitAndLossByDimensionSchema = z.object({
  ...Range,
  dimensionId: id.optional().describe("The dimension (Class, Location, …) to split by. Defaults to the first one."),
});

export async function profitAndLossByDimension(ctx: Ctx, input: z.input<typeof ProfitAndLossByDimensionSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the profit and loss");
  const f = ProfitAndLossByDimensionSchema.parse(input);
  const { from, to } = range(f);
  const org = ctx.actor.organizationId;
  const [dim] = await ctx.tx
    .select()
    .from(dimensions)
    .where(and(eq(dimensions.organizationId, org), isNull(dimensions.deletedAt), f.dimensionId ? eq(dimensions.id, f.dimensionId) : undefined))
    .orderBy(asc(dimensions.sortOrder))
    .limit(1);
  if (f.dimensionId && !dim) throw notFound("Dimension");
  const net = dim
    ? await netByBucket(ctx, {
        from,
        to,
        bucket: sql`ld.value_id::text`,
        joins: sql`LEFT JOIN gl_line_dimensions ld ON ld.line_id = l.id AND ld.dimension_id = ${dim.id}`,
        category: "income_statement",
      })
    : await netByBucket(ctx, { from, to, bucket: sql`NULL`, category: "income_statement" });
  const used = new Set<string>();
  for (const byBucket of net.values()) for (const k of byBucket.keys()) used.add(k);
  const values = dim
    ? await ctx.tx
        .select({ id: dimensionValues.id, code: dimensionValues.code, name: dimensionValues.name })
        .from(dimensionValues)
        .where(and(eq(dimensionValues.organizationId, org), eq(dimensionValues.dimensionId, dim.id)))
        .orderBy(asc(dimensionValues.code))
    : [];
  const shown = values.filter((v) => used.has(v.id));
  const buckets = [...shown.map((v) => v.id), ...(used.has("") || shown.length === 0 ? [""] : [])];
  const labels = [...shown.map((v) => v.name), ...(buckets.includes("") ? [dim ? `No ${dim.name.toLowerCase()}` : "All"] : [])];
  const cols = withTotal(net, buckets);
  const { rows } = pnlRows(await pnlAccounts(ctx), net, cols);
  return {
    title: `Profit and Loss by ${dim?.name ?? "Class"}`,
    subtitle: rangeLabel(from, to),
    labelColumn: "Account",
    columns: [...labels, "Total"],
    rows,
    notes: dim ? undefined : ["No classes or locations are set up yet, so everything is in one column."],
  };
}

// ---------------------------------------------------------------------------
// Budget vs actual
// ---------------------------------------------------------------------------

export const BudgetVsActualSchema = z.object({
  ...Range,
  budgetId: id.optional().describe("The budget to compare with. Defaults to the newest one."),
});

export async function budgetVsActual(ctx: Ctx, input: z.input<typeof BudgetVsActualSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run budget vs actual");
  const f = BudgetVsActualSchema.parse(input);
  const { from, to } = range(f);
  const org = ctx.actor.organizationId;
  const [budget] = await ctx.tx
    .select()
    .from(budgets)
    .where(and(eq(budgets.organizationId, org), f.budgetId ? eq(budgets.id, f.budgetId) : undefined))
    .orderBy(desc(budgets.createdAt))
    .limit(1);
  if (f.budgetId && !budget) throw notFound("Budget");

  const net = await netByBucket(ctx, { from, to, bucket: sql`'actual'`, category: "income_statement" });
  const accts = await pnlAccounts(ctx);
  const normal = new Map(accts.map((a) => [a.id, a.normalBalance]));
  if (budget) {
    // Budgets count whole periods inside the range; amounts are entered as
    // they read (revenue and expenses both positive), so turn them back
    // into net debit for the shared P&L math.
    const planned = await ctx.tx.execute<{ account_id: string; amount: string }>(sql`
      SELECT e.account_id, SUM(e.amount)::text AS amount
        FROM budget_entries e
        JOIN fiscal_periods p ON p.id = e.period_id
       WHERE e.organization_id = ${org} AND e.budget_id = ${budget.id}
         AND p.start_date >= ${from}::date AND p.end_date <= ${to}::date
       GROUP BY e.account_id
    `);
    for (const r of planned) {
      const amt = money(r.amount);
      const asNet = normal.get(r.account_id) === "credit" ? amt.neg() : amt;
      const byBucket = net.get(r.account_id) ?? new Map<string, Decimal>();
      byBucket.set("budget", (byBucket.get("budget") ?? money(0)).plus(asNet));
      net.set(r.account_id, byBucket);
    }
  }
  const { rows } = pnlRows(accts, net, ["actual", "budget"]);
  for (const r of rows) {
    if (r.kind === "section" || r.kind === "note") {
      r.values = [null, null, null, null];
      continue;
    }
    const actual = money(r.values[0] ?? 0);
    const planned = money(r.values[1] ?? 0);
    r.values = [fmt2(actual), fmt2(planned), fmt2(actual.minus(planned)), planned.isZero() ? null : `${actual.div(planned).times(100).toFixed(1)}%`];
  }
  return {
    title: "Budget vs Actual",
    subtitle: `${budget ? `${budget.name} · ` : ""}${rangeLabel(from, to)}`,
    labelColumn: "Account",
    columns: ["Actual", "Budget", "Over budget", "% of budget"],
    rows,
    notes: budget
      ? ["Budget amounts count the fiscal periods that fall wholly inside the range."]
      : ["No budget yet. Create one under Accounting → Budgets to compare."],
  };
}

// ---------------------------------------------------------------------------
// Statement of cash flows (indirect method)
// ---------------------------------------------------------------------------

export const CashFlowSchema = z.object(Range);

const OPERATING: Account["subcategory"][] = ["receivables", "inventory", "other_current_asset", "payables", "accrued_liabilities", "other_current_liability"];
const INVESTING: Account["subcategory"][] = ["fixed_assets", "other_asset"];
const FINANCING: Account["subcategory"][] = ["lt_debt", "other_liability", "equity", "retained_earnings"];

export type CashFlow = ReportTable & {
  cash: { beginning: string; netChange: string; ending: string; reconciles: boolean };
};

/**
 * Net income, adjusted by the change in every balance sheet account other
 * than cash, grouped into operating, investing, and financing. Cash means
 * accounts in the cash subcategory (banks, petty cash, undeposited funds).
 * The net change always equals the change in those accounts' balances; a
 * mismatch would mean an unbalanced journal, and the table says so.
 */
export async function cashFlow(ctx: Ctx, input: z.input<typeof CashFlowSchema> = {}): Promise<CashFlow> {
  requirePermission(ctx.actor, "read", "viewer", "run the statement of cash flows");
  const { from, to } = range(CashFlowSchema.parse(input));
  const org = ctx.actor.organizationId;

  const pnl = await netByBucket(ctx, { from, to, bucket: sql`'all'`, category: "income_statement" });
  let netIncome = money(0);
  for (const byBucket of pnl.values()) netIncome = netIncome.minus(byBucket.get("all") ?? money(0));

  const bs = await netByBucket(ctx, { from, to, bucket: sql`'all'`, category: "balance_sheet" });
  const bsAccounts = await ctx.tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, subcategory: accounts.subcategory })
    .from(accounts)
    .where(and(eq(accounts.organizationId, org), eq(accounts.category, "balance_sheet")))
    .orderBy(asc(accounts.code));

  const rows: ReportRow[] = [];
  const section = (label: string, total: string, subcats: Account["subcategory"][], lead?: ReportRow) => {
    rows.push({ kind: "section", label, values: [null] });
    let sum = money(0);
    if (lead) {
      rows.push(lead);
      sum = sum.plus(money(lead.values[0] ?? 0));
    }
    for (const a of bsAccounts.filter((x) => subcats.includes(x.subcategory))) {
      const change = bs.get(a.id)?.get("all") ?? money(0);
      if (change.isZero()) continue;
      // More asset (net debit up) used cash; more liability or equity (net debit down) brought it in.
      const effect = change.neg();
      sum = sum.plus(effect);
      rows.push({ kind: "account", label: a.name, code: a.code, accountId: a.id, depth: 1, values: [fmt2(effect)] });
    }
    rows.push({ kind: "subtotal", label: total, values: [fmt2(sum)] });
    return sum;
  };
  const operating = section("Operating Activities", "Net cash from operating activities", OPERATING, {
    kind: "account",
    label: "Net Income",
    depth: 1,
    values: [fmt2(netIncome)],
  });
  const investing = section("Investing Activities", "Net cash from investing activities", INVESTING);
  const financing = section("Financing Activities", "Net cash from financing activities", FINANCING);
  const netChange = operating.plus(investing).plus(financing);

  const [cash] = await ctx.tx.execute<{ before: string; during: string }>(sql`
    SELECT COALESCE(SUM(CASE WHEN j.journal_date < ${from}::date THEN l.debit_local - l.credit_local ELSE 0 END), 0)::text AS before,
           COALESCE(SUM(CASE WHEN j.journal_date BETWEEN ${from}::date AND ${to}::date THEN l.debit_local - l.credit_local ELSE 0 END), 0)::text AS during
      FROM gl_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id
     WHERE l.organization_id = ${org} AND j.status IN ('posted', 'reversed') AND a.subcategory = 'cash'
       AND j.journal_date <= ${to}::date
  `);
  const beginning = money(cash?.before ?? 0);
  const actualChange = money(cash?.during ?? 0);
  const reconciles = actualChange.minus(netChange).abs().lt(0.005);

  rows.push({ kind: "total", label: "Net change in cash", values: [fmt2(netChange)] });
  rows.push({ kind: "account", label: "Cash at beginning of period", values: [fmt2(beginning)] });
  rows.push({ kind: "total", label: "Cash at end of period", values: [fmt2(beginning.plus(netChange))] });

  return {
    title: "Statement of Cash Flows",
    subtitle: rangeLabel(from, to),
    labelColumn: "",
    columns: ["Amount"],
    rows,
    notes: reconciles ? undefined : [`The ledger's cash moved ${fmt2(actualChange)}, not ${fmt2(netChange)}. An unbalanced journal is the usual cause.`],
    cash: { beginning: fmt2(beginning), netChange: fmt2(netChange), ending: fmt2(beginning.plus(netChange)), reconciles },
  };
}

/** Budgets and dimensions for the report pickers. */
export async function reportChoices(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "run reports");
  const org = ctx.actor.organizationId;
  const [budgetRows, dimensionRows] = await Promise.all([
    ctx.tx.select({ id: budgets.id, code: budgets.code, name: budgets.name }).from(budgets).where(eq(budgets.organizationId, org)).orderBy(desc(budgets.createdAt)),
    ctx.tx
      .select({ id: dimensions.id, code: dimensions.code, name: dimensions.name })
      .from(dimensions)
      .where(and(eq(dimensions.organizationId, org), isNull(dimensions.deletedAt)))
      .orderBy(asc(dimensions.sortOrder)),
  ]);
  return { budgets: budgetRows, dimensions: dimensionRows };
}
