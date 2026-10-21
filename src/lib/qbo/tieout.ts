import Decimal from "decimal.js";
import { addMonths, endOfMonth, format, parseISO, startOfMonth } from "date-fns";
import { and, eq, sql } from "drizzle-orm";
import { accounts, organizations, qboIdMap, qboImports, qboTieoutAmounts } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { ensureFiscalYearFor } from "@/lib/gl/fiscal-calendar";
import { sourceCodeId } from "@/lib/gl/lookups";
import { createAndPostJournal, type JournalLineInput } from "@/lib/gl/posting";
import { money, toDbMoney } from "@/lib/money";
import { QboClient } from "./client";
import { latestImport, loadConnection, requireHuman } from "./service";

/**
 * THE TIE-OUT. QuickBooks' books month by month (its balance sheet and
 * P&L by month) beside the ledger here. Each month lists the accounts that
 * differ; an admin posts one labeled conversion entry per month that closes
 * them. Opening Balance Equity balances each entry: it takes what's left
 * over (an account that didn't come across, rounding), which also settles
 * its own difference. QuickBooks' numbers are read once and kept;
 * the ledger's are read live, so a posted entry clears its month.
 *
 * Amounts are each account's activity in the month (for balance sheet
 * accounts, the change in balance) on its statement section's side: assets
 * and expenses debit, the rest credit, as QuickBooks' reports show them.
 * Retained Earnings is left out: QuickBooks computes its balance.
 */

const DEBIT_SIDE = new Set<string>([
  "cash", "receivables", "inventory", "other_current_asset", "fixed_assets", "other_asset",
  "cogs_labor", "cogs_materials", "cogs_equipment", "cogs_subcontractor", "cogs_other",
  "operating_expense", "sga", "interest", "tax", "other_expense",
]);
const RETAINED_EARNINGS = "3200";
/** Opening Balance Equity balances each entry, so its own difference settles through what's left over. */
const OPENING_BALANCE = "3300";
const CENT = money("0.005");

type Cell = { value?: string; id?: string };
type Row = { ColData?: Cell[]; Rows?: { Row?: Row[] }; Header?: { ColData?: Cell[] } };
type Report = { Columns?: { Column?: Array<{ ColTitle?: string; MetaData?: Array<{ Name?: string; Value?: string }> }> }; Rows?: { Row?: Row[] } };

/** Account rows of a by-month report: QuickBooks account id → name and amount per month ("2026-03"). */
function byMonth(report: Report): Map<string, { name: string; months: Map<string, Decimal> }> {
  const cols = (report.Columns?.Column ?? []).map((c) => c.MetaData?.find((m) => m.Name === "StartDate")?.Value?.slice(0, 7) ?? null);
  const out = new Map<string, { name: string; months: Map<string, Decimal> }>();
  const walk = (rows: Row[] | undefined) => {
    for (const r of rows ?? []) {
      const id = r.ColData?.[0]?.id;
      if (id) {
        const months = new Map<string, Decimal>();
        cols.forEach((m, i) => {
          if (m) months.set(m, money((r.ColData?.[i]?.value ?? "").replace(/,/g, "") || "0"));
        });
        out.set(id, { name: r.ColData?.[0]?.value ?? id, months });
      }
      walk(r.Rows?.Row);
    }
  };
  walk(report.Rows?.Row);
  return out;
}

const monthKey = (d: Date) => format(d, "yyyy-MM");
const monthLabel = (m: string) => format(parseISO(`${m}-01`), "MMMM yyyy");

/** Read QuickBooks' books by month and keep them for the tie-out. People only. */
export async function refreshTieout(ctx: Ctx): Promise<Tieout> {
  requireHuman(ctx, "compare the books with QuickBooks");
  const imp = await latestImport(ctx, false);
  if (!imp || imp.status !== "done") throw new AppError("invalid_state", "Finish the QuickBooks import first.");
  const client = new QboClient(await loadConnection(ctx));
  const org = ctx.actor.organizationId;

  const [range] = await ctx.tx.execute<{ first: string | null; last: string | null }>(sql`
    SELECT min(j.journal_date)::text AS first, max(j.journal_date)::text AS last
      FROM gl_journals j WHERE j.organization_id = ${org} AND j.status IN ('posted', 'reversed')`);
  if (!range?.first) throw new AppError("invalid_state", "There's nothing in the books yet to compare.");
  const first = startOfMonth(parseISO(range.first));
  const lastDate = parseISO(range.last!) > new Date() ? parseISO(range.last!) : new Date();
  const last = startOfMonth(lastDate);

  const mapped = new Map(
    (
      await ctx.tx
        .select({ qboId: qboIdMap.qboId, accountId: qboIdMap.localId, code: accounts.code })
        .from(qboIdMap)
        .innerJoin(accounts, eq(accounts.id, qboIdMap.localId))
        .where(and(eq(qboIdMap.organizationId, org), eq(qboIdMap.entity, "Account")))
    ).map((r) => [r.qboId, r])
  );

  // A year of months per request; balances carry from one request to the next.
  const amounts = new Map<string, { qboAccountId: string; name: string; month: string; amount: Decimal }>();
  const add = (qboAccountId: string, name: string, month: string, amount: Decimal) => {
    if (amount.isZero()) return;
    amounts.set(`${month}|${qboAccountId}`, { qboAccountId, name, month, amount });
  };
  const carried = new Map<string, Decimal>();
  for (let from = first; from <= last; from = addMonths(from, 12)) {
    const to = endOfMonth(addMonths(from, 11) < last ? addMonths(from, 11) : last);
    const params = { start_date: format(from, "yyyy-MM-dd"), end_date: format(to, "yyyy-MM-dd"), summarize_column_by: "Month", accounting_method: "Accrual" };
    const bs = byMonth(await client.report<Report>("BalanceSheet", params));
    const pl = byMonth(await client.report<Report>("ProfitAndLoss", params));
    for (const [id, a] of bs) {
      let prev = carried.get(id) ?? money(0);
      for (const [m, balance] of [...a.months].sort(([x], [y]) => x.localeCompare(y))) {
        add(id, a.name, m, balance.minus(prev));
        prev = balance;
      }
      carried.set(id, prev);
    }
    for (const [id, a] of pl) for (const [m, activity] of a.months) add(id, a.name, m, activity);
  }

  await ctx.tx.delete(qboTieoutAmounts).where(eq(qboTieoutAmounts.organizationId, org));
  const rows = [...amounts.values()]
    .filter((a) => mapped.get(a.qboAccountId)?.code !== RETAINED_EARNINGS)
    .map((a) => ({
      organizationId: org,
      month: `${a.month}-01`,
      qboAccountId: a.qboAccountId,
      qboAccountName: a.name.slice(0, 200),
      accountId: mapped.get(a.qboAccountId)?.accountId ?? null,
      amount: toDbMoney(a.amount),
    }));
  for (let i = 0; i < rows.length; i += 500) await ctx.tx.insert(qboTieoutAmounts).values(rows.slice(i, i + 500));
  await ctx.tx.update(qboImports).set({ tieoutAt: sql`now()`, updatedAt: sql`now()` }).where(eq(qboImports.id, imp.id));
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "qbo.tieout.refreshed",
      entityType: "organization",
      entityId: org,
      metadata: { from: monthKey(first), to: monthKey(last), amounts: rows.length },
    },
    ctx.tx
  );
  return getTieout(ctx);
}

export type TieoutLine = {
  accountId: string | null;
  code: string | null;
  name: string;
  /** On the account's section side (assets and expenses debit, the rest credit). */
  here: string;
  quickbooks: string;
  difference: string;
};
export type Tieout = {
  ready: boolean;
  refreshedAt: Date | null;
  monthsCompared: number;
  months: Array<{ month: string; label: string; lines: TieoutLine[]; postable: boolean }>;
};

/** The months whose activity differs from QuickBooks', and by how much per account. */
export async function getTieout(ctx: Ctx): Promise<Tieout> {
  requirePermission(ctx.actor, "read", "viewer", "view the QuickBooks tie-out");
  const org = ctx.actor.organizationId;
  const imp = await latestImport(ctx, false);
  if (!imp?.tieoutAt) return { ready: false, refreshedAt: null, monthsCompared: 0, months: [] };

  const theirs = await ctx.tx.select().from(qboTieoutAmounts).where(eq(qboTieoutAmounts.organizationId, org));
  const ours = await ctx.tx.execute<{ month: string; account_id: string; net: string }>(sql`
    SELECT to_char(date_trunc('month', j.journal_date), 'YYYY-MM') AS month, l.account_id, sum(l.debit_local - l.credit_local)::text AS net
      FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
     WHERE l.organization_id = ${org} AND j.status IN ('posted', 'reversed')
     GROUP BY 1, 2`);
  const accts = new Map(
    (
      await ctx.tx
        .select({ id: accounts.id, code: accounts.code, name: accounts.name, subcategory: accounts.subcategory })
        .from(accounts)
        .where(eq(accounts.organizationId, org))
    ).map((a) => [a.id, a])
  );
  const side = (accountId: string) => (DEBIT_SIDE.has(accts.get(accountId)?.subcategory ?? "") ? 1 : -1);

  type Cell = { accountId: string | null; name: string; here: Decimal; quickbooks: Decimal };
  const cells = new Map<string, Cell>();
  const cell = (month: string, key: string, init: () => Cell) => {
    const k = `${month}|${key}`;
    if (!cells.has(k)) cells.set(k, init());
    return cells.get(k)!;
  };
  for (const t of theirs) {
    const month = t.month.slice(0, 7);
    const key = t.accountId ?? `qbo:${t.qboAccountId}`;
    const c = cell(month, key, () => ({ accountId: t.accountId, name: t.qboAccountName ?? t.qboAccountId, here: money(0), quickbooks: money(0) }));
    c.quickbooks = c.quickbooks.plus(money(t.amount));
  }
  for (const o of ours) {
    const a = accts.get(o.account_id);
    if (!a || a.code === RETAINED_EARNINGS) continue;
    const c = cell(o.month, o.account_id, () => ({ accountId: o.account_id, name: a.name, here: money(0), quickbooks: money(0) }));
    c.here = c.here.plus(money(o.net).times(side(o.account_id)));
  }

  const months = new Map<string, TieoutLine[]>();
  const compared = new Set<string>();
  for (const [k, c] of cells) {
    const month = k.split("|")[0];
    compared.add(month);
    const diff = c.quickbooks.minus(c.here);
    if (diff.abs().lt(CENT)) continue;
    const list = months.get(month) ?? [];
    list.push({
      accountId: c.accountId,
      code: c.accountId ? (accts.get(c.accountId)?.code ?? null) : null,
      name: c.name,
      here: toDbMoney(c.here),
      quickbooks: toDbMoney(c.quickbooks),
      difference: toDbMoney(diff),
    });
    months.set(month, list);
  }
  return {
    ready: true,
    refreshedAt: imp.tieoutAt,
    monthsCompared: compared.size,
    months: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, lines]) => ({
        month,
        label: monthLabel(month),
        lines: lines.sort((x, y) => (x.code ?? "~").localeCompare(y.code ?? "~")),
        postable: lines.some((l) => l.accountId && l.code !== OPENING_BALANCE),
      })),
  };
}

/**
 * Post the conversion entries that close the differences: one journal per
 * month, dated its last day, labeled. People only. Without `month`, every
 * month that has something to post.
 */
export async function postTieoutEntries(ctx: Ctx, input: { month?: string } = {}): Promise<Tieout> {
  requireHuman(ctx, "post tie-out entries");
  const t = await getTieout(ctx);
  const org = ctx.actor.organizationId;
  const todo = t.months.filter((m) => m.postable && (!input.month || m.month === input.month));
  if (todo.length === 0) {
    throw new AppError("invalid_state", "Nothing to post: what's left is on QuickBooks accounts that didn't come across, or the months already tie.");
  }
  const [o] = await ctx.tx.select({ startMonth: organizations.fiscalYearStartMonth }).from(organizations).where(eq(organizations.id, org));
  const [obe] = await ctx.tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.organizationId, org), eq(accounts.code, OPENING_BALANCE)));
  const subcats = new Map((await ctx.tx.select({ id: accounts.id, subcategory: accounts.subcategory }).from(accounts).where(eq(accounts.organizationId, org))).map((a) => [a.id, a.subcategory]));

  for (const m of todo) {
    const date = format(endOfMonth(parseISO(`${m.month}-01`)), "yyyy-MM-dd");
    const lines: JournalLineInput[] = [];
    let net = money(0); // debits − credits
    for (const l of m.lines) {
      if (!l.accountId || l.code === OPENING_BALANCE) continue;
      // Raise the account on its own side by the difference.
      const signed = money(l.difference).times(DEBIT_SIDE.has(subcats.get(l.accountId) ?? "") ? 1 : -1);
      net = net.plus(signed);
      lines.push({
        accountId: l.accountId,
        ...(signed.gt(0) ? { debit: toDbMoney(signed) } : { credit: toDbMoney(signed.abs()) }),
        memo: `QuickBooks ${money(l.quickbooks).toFixed(2)}, here ${money(l.here).toFixed(2)}`,
      });
    }
    if (!net.abs().lt(CENT)) {
      if (!obe) throw new AppError("invalid_state", "There's no 3300 Opening Balance Equity account to balance the entry.");
      lines.push({
        accountId: obe.id,
        ...(net.gt(0) ? { credit: toDbMoney(net) } : { debit: toDbMoney(net.abs()) }),
        memo: "What's left: accounts that didn't come across, or rounding",
      });
    }
    await ensureFiscalYearFor(ctx.tx, org, o.startMonth, date);
    const result = await createAndPostJournal(
      {
        organizationId: org,
        actorId: ctx.actor.userId,
        actor: ctx.actor,
        journalDate: date,
        sourceCodeId: await sourceCodeId(ctx.tx, org, "GJ"),
        source: "conversion",
        description: `QuickBooks tie-out, ${m.label}`,
        documentNo: `TIEOUT-${m.month}`,
        lines,
      },
      ctx.tx
    );
    if (!result.ok) throw new AppError("posting_failed", `${m.label}: ${result.error}`, { postingCode: result.code });
    await writeAudit(
      {
        organizationId: org,
        ...auditFields(ctx.actor),
        event: "qbo.tieout.posted",
        entityType: "gl_journal",
        entityId: result.journalId,
        metadata: { month: m.month, lines: lines.length },
      },
      ctx.tx
    );
  }
  return getTieout(ctx);
}
