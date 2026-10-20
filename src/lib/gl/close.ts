import { format, parseISO } from "date-fns";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { closeTaskCompletions, closeTasks, fiscalPeriods, fiscalYears, organizations, profiles, type FiscalPeriod } from "@/lib/db/schema";
import { auditFields, requirePermission, type Actor, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { AppError, notFound } from "@/lib/errors";
import { formatMoney, money, type MoneyInput } from "@/lib/money";
import { apAging, arAging } from "@/lib/reports/aging";
import { Range, range, rangeLabel } from "@/lib/reports/statements";
import { fmt2, type ReportRow, type ReportTable } from "@/lib/reports/table";
import { id, optionalText } from "@/lib/schemas";

/**
 * MONTH-END CLOSE.
 *
 * The books close through a period: closing March also closes any earlier
 * period still open, and reopening March reopens everything after it.
 *   soft_closed  only adjusting and reversing entries post (validations.ts)
 *   hard_closed  nothing posts without the closing password
 *
 * Before closing, a checklist runs as of the period's last day: bank and
 * card accounts reconciled, nothing waiting in For review, no drafts, AR and
 * AP tie to their control accounts, Undeposited Funds and holding accounts
 * cleared, recurring templates run, and the company's own checklist items
 * signed off. Anything open is a warning: closing anyway takes a note,
 * which lands on the period and in the audit log.
 *
 * Only people close and reopen (admins and owners); agents read the
 * checklist. Hard close, and reopening a hard-closed period, take the
 * closing password, which only the owner sets.
 *
 * Year end: closing the last period of a fiscal year hard closes the year.
 * There is no closing entry: the balance sheet computes retained earnings
 * from prior years' net income (gl/reports.ts).
 */

const RANK: Record<FiscalPeriod["status"], number> = { open: 0, soft_closed: 1, hard_closed: 2 };

const day = (d: string) => format(parseISO(d), "MMM d, yyyy");

function requirePerson(actor: Actor, action: string): string {
  if (actor.kind !== "user" || !actor.userId) throw new AppError("forbidden", `Only a person can ${action}; agents can read the close checklist.`);
  if (actor.support) throw new AppError("forbidden", `Support access is read-only and can't ${action}.`);
  return actor.userId;
}

async function loadPeriod(ctx: Ctx, periodId: string) {
  const [p] = await ctx.tx
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.organizationId, ctx.actor.organizationId)));
  if (!p) throw notFound("Period");
  return p;
}

async function checkClosingPassword(ctx: Ctx, password: string | undefined) {
  const [org] = await ctx.tx
    .select({ hash: organizations.hardCloseOverridePasswordHash })
    .from(organizations)
    .where(eq(organizations.id, ctx.actor.organizationId));
  if (!org?.hash) throw new AppError("invalid_state", "Set a closing password first (Close Books › Closing password).");
  if (!password) throw new AppError("invalid_input", "The closing password is required.");
  if (!(await verifyPassword(password, org.hash))) throw new AppError("invalid_input", "That isn't the closing password.");
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export type CloseCheck = {
  key: string;
  title: string;
  ok: boolean;
  detail: string;
  /** What's open, each with a link to fix it. */
  items: Array<{ label: string; href?: string }>;
};

export type CloseChecklist = {
  period: FiscalPeriod & { closedByEmail: string | null };
  checks: CloseCheck[];
  tasks: Array<{ id: string; title: string; description: string | null; done: boolean; completedAt: Date | null; completedByEmail: string | null; note: string | null }>;
  /** Open checks plus tasks not signed off. Closing with any takes a note. */
  openItems: number;
  /** Earlier periods still open; closing this one closes them too. */
  alsoCloses: string[];
};

export const PeriodIdSchema = z.object({ id: id.describe("The fiscal period (list_periods).") });

type Count = { label: string; href: string; n: number };

function countCheck(key: string, title: string, rows: Count[], okText: string, open: (n: number) => string): CloseCheck {
  const items = rows.filter((r) => r.n > 0);
  const n = items.reduce((acc, r) => acc + r.n, 0);
  return {
    key,
    title,
    ok: n === 0,
    detail: n === 0 ? okText : open(n),
    items: items.map((r) => ({ label: `${r.n} ${r.label}`, href: r.href })),
  };
}

/** GL balance (debit − credit) of the accounts matching `where`, through `end`. */
async function balanceThrough(ctx: Ctx, end: string, where: ReturnType<typeof sql>, from?: string) {
  const [r] = await ctx.tx.execute<{ net: string }>(sql`
    SELECT COALESCE(SUM(l.debit_local - l.credit_local), 0)::text AS net
      FROM gl_lines l
      JOIN gl_journals j ON j.id = l.journal_id
      JOIN accounts a ON a.id = l.account_id
     WHERE l.organization_id = ${ctx.actor.organizationId}
       AND j.status IN ('posted', 'reversed')
       AND j.journal_date <= ${end}::date
       ${from ? sql`AND j.journal_date >= ${from}::date` : sql``}
       AND ${where}
  `);
  return money(r?.net ?? 0);
}

async function runChecks(ctx: Ctx, p: FiscalPeriod): Promise<CloseCheck[]> {
  const org = ctx.actor.organizationId;
  const end = p.endDate;
  const checks: CloseCheck[] = [];
  const [{ currency }] = await ctx.tx.select({ currency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, org));
  const cash = (v: MoneyInput) => formatMoney(v, { currency });

  // Bank and card accounts reconciled through the period end.
  const banks = await ctx.tx.execute<{ id: string; code: string; name: string; through: string | null; active: boolean }>(sql`
    SELECT a.id, a.code, a.name,
           (SELECT MAX(r.statement_end_date)::text FROM reconciliations r WHERE r.account_id = a.id AND r.status = 'completed') AS through,
           EXISTS (SELECT 1 FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
                    WHERE l.account_id = a.id AND j.status IN ('posted', 'reversed') AND j.journal_date <= ${end}::date) AS active
      FROM accounts a
     WHERE a.organization_id = ${org} AND a.is_reconciliation AND a.is_active AND a.account_type = 'posting' AND a.deleted_at IS NULL
     ORDER BY a.code
  `);
  const behind = banks.filter((b) => b.active && (!b.through || b.through < end));
  checks.push({
    key: "reconciled",
    title: "Bank and card accounts reconciled",
    ok: behind.length === 0,
    detail:
      behind.length === 0
        ? `Every account with activity is reconciled through ${day(end)}.`
        : `${behind.length} account${behind.length === 1 ? " isn't" : "s aren't"} reconciled through ${day(end)}.`,
    items: behind.map((b) => ({ label: `${b.code} ${b.name}: ${b.through ? `reconciled through ${day(b.through)}` : "never reconciled"}`, href: `/banking/reconcile?account=${b.id}` })),
  });

  // Imported bank lines still waiting in For review.
  const [review] = await ctx.tx.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM bank_statement_lines
     WHERE organization_id = ${org} AND status = 'for_review' AND posted_date <= ${end}::date
  `);
  checks.push(
    countCheck("for_review", "Bank feed reviewed", [{ label: "bank lines waiting in For review", href: "/banking/review", n: review?.n ?? 0 }], "Nothing dated in or before the period is waiting in For review.", (n) => `${n} imported bank line${n === 1 ? " is" : "s are"} still waiting.`)
  );

  // Unposted documents dated on or before the period end.
  const [d] = await ctx.tx.execute<Record<string, number>>(sql`
    SELECT
      (SELECT COUNT(*) FROM gl_journals WHERE organization_id = ${org} AND status IN ('draft', 'pending_approval') AND journal_date <= ${end}::date)::int AS journals,
      (SELECT COUNT(*) FROM ar_invoices WHERE organization_id = ${org} AND status = 'draft' AND invoice_date <= ${end}::date)::int AS invoices,
      (SELECT COUNT(*) FROM ar_payments WHERE organization_id = ${org} AND status = 'draft' AND payment_date <= ${end}::date)::int AS payments,
      (SELECT COUNT(*) FROM sales_receipts WHERE organization_id = ${org} AND status = 'draft' AND receipt_date <= ${end}::date)::int AS receipts,
      (SELECT COUNT(*) FROM credit_memos WHERE organization_id = ${org} AND status = 'draft' AND memo_date <= ${end}::date)::int AS memos,
      (SELECT COUNT(*) FROM refund_receipts WHERE organization_id = ${org} AND status = 'draft' AND refund_date <= ${end}::date)::int AS refunds,
      (SELECT COUNT(*) FROM ap_bills WHERE organization_id = ${org} AND status IN ('draft', 'pending_approval', 'approved') AND COALESCE(posting_date, bill_date) <= ${end}::date)::int AS bills,
      (SELECT COUNT(*) FROM ap_payments WHERE organization_id = ${org} AND status = 'draft' AND payment_date <= ${end}::date)::int AS bill_payments,
      (SELECT COUNT(*) FROM vendor_credits WHERE organization_id = ${org} AND status = 'draft' AND credit_date <= ${end}::date)::int AS vendor_credits,
      (SELECT COUNT(*) FROM vendor_refunds WHERE organization_id = ${org} AND status = 'draft' AND refund_date <= ${end}::date)::int AS vendor_refunds,
      (SELECT COUNT(*) FROM bank_transactions WHERE organization_id = ${org} AND status = 'draft' AND txn_date <= ${end}::date)::int AS bank
  `);
  checks.push(
    countCheck(
      "drafts",
      "Nothing left unposted",
      [
        { label: "journal entries", href: "/gl", n: d.journals },
        { label: "invoices", href: "/ar/invoices", n: d.invoices },
        { label: "customer payments", href: "/ar/payments", n: d.payments },
        { label: "sales receipts", href: "/ar/sales-receipts", n: d.receipts },
        { label: "credit memos", href: "/ar/credit-memos", n: d.memos },
        { label: "refunds", href: "/ar/refunds", n: d.refunds },
        { label: "bills (draft or awaiting approval)", href: "/ap/bills", n: d.bills },
        { label: "bill payments", href: "/ap/payments", n: d.bill_payments },
        { label: "vendor credits", href: "/ap/vendor-credits", n: d.vendor_credits },
        { label: "vendor refunds", href: "/ap/vendor-refunds", n: d.vendor_refunds },
        { label: "bank transactions", href: "/banking/transactions", n: d.bank },
      ],
      "No drafts dated in or before the period.",
      (n) => `${n} draft${n === 1 ? " is" : "s are"} dated in or before the period. Post or delete them.`
    )
  );

  // Subledgers tie to their control accounts (amounts at face value).
  const [ar, ap] = await Promise.all([arAging(ctx, { asOf: end }), apAging(ctx, { asOf: end })]);
  const arGl = await balanceThrough(ctx, end, sql`a.is_control AND a.subcategory = 'receivables'`);
  const apGl = (await balanceThrough(ctx, end, sql`a.is_control AND a.subcategory = 'payables'`)).neg();
  for (const [key, title, sub, gl, href] of [
    ["ar_ties", "Receivables tie to the ledger", money(ar.totals.total), arGl, "/reports/open-invoices"],
    ["ap_ties", "Payables tie to the ledger", money(ap.totals.total), apGl, "/reports/unpaid-bills"],
  ] as const) {
    const diff = sub.minus(gl);
    checks.push({
      key,
      title,
      ok: diff.isZero(),
      detail: diff.isZero()
        ? `Open documents and the control account both total ${cash(gl)}.`
        : `Open documents total ${cash(sub)}, the control account ${cash(gl)}: ${cash(diff.abs())} apart.`,
      items: diff.isZero() ? [] : [{ label: "Compare the open documents with the control account", href: `${href}?asOf=${end}` }],
    });
  }

  // Undeposited Funds cleared.
  const uf = await balanceThrough(ctx, end, sql`a.code = '1250' AND a.is_cash`);
  checks.push({
    key: "undeposited",
    title: "Undeposited Funds cleared",
    ok: uf.isZero(),
    detail: uf.isZero() ? "Nothing waiting to be deposited." : `${cash(uf)} was received but not deposited by ${day(end)}.`,
    items: uf.isZero() ? [] : [{ label: "Record the deposits", href: "/banking/transactions/new?type=deposit" }],
  });

  // Holding accounts emptied: balance sheet ones as of the end, P&L ones for the fiscal year to date.
  const [fy] = await ctx.tx.select({ startDate: fiscalYears.startDate }).from(fiscalYears).where(eq(fiscalYears.id, p.fiscalYearId));
  const holding = await ctx.tx.execute<{ id: string; code: string; name: string; net: string }>(sql`
    SELECT a.id, a.code, a.name, COALESCE(SUM(l.debit_local - l.credit_local), 0)::text AS net
      FROM accounts a
      JOIN gl_lines l ON l.account_id = a.id
      JOIN gl_journals j ON j.id = l.journal_id
     WHERE a.organization_id = ${org}
       AND (a.name ILIKE '%uncategori%' OR a.name ILIKE '%suspense%' OR a.name ILIKE '%ask my accountant%')
       AND j.status IN ('posted', 'reversed')
       AND j.journal_date <= ${end}::date
       AND (a.category = 'balance_sheet' OR j.journal_date >= ${fy?.startDate ?? p.startDate}::date)
     GROUP BY a.id, a.code, a.name
    HAVING SUM(l.debit_local - l.credit_local) <> 0
     ORDER BY a.code
  `);
  checks.push({
    key: "holding",
    title: "Holding accounts emptied",
    ok: holding.length === 0,
    detail: holding.length === 0 ? "Nothing sits in uncategorized or suspense accounts." : `${holding.length} holding account${holding.length === 1 ? " has" : "s have"} a balance to reclassify.`,
    items: holding.map((h) => ({ label: `${h.code} ${h.name}: ${cash(money(h.net).abs())}`, href: `/reports/gl-detail?account=${h.id}&to=${end}` })),
  });

  // Recurring templates due by the period end have run.
  const [rec] = await ctx.tx.execute<Record<string, number>>(sql`
    SELECT
      (SELECT COUNT(*) FROM recurring_journals WHERE organization_id = ${org} AND status = 'active' AND next_run_date <= ${end}::date)::int AS journals,
      (SELECT COUNT(*) FROM recurring_invoices WHERE organization_id = ${org} AND status = 'active' AND type = 'scheduled' AND next_run_date <= ${end}::date)::int AS invoices,
      (SELECT COUNT(*) FROM recurring_bills WHERE organization_id = ${org} AND status = 'active' AND type = 'scheduled' AND next_run_date <= ${end}::date)::int AS bills
  `);
  checks.push(
    countCheck(
      "recurring",
      "Recurring transactions run",
      [
        { label: "recurring journal entries", href: "/recurring", n: rec.journals },
        { label: "recurring invoices", href: "/ar/recurring", n: rec.invoices },
        { label: "recurring bills", href: "/ap/recurring", n: rec.bills },
      ],
      "Every recurring template due by the period end has run.",
      (n) => `${n} recurring template${n === 1 ? " is" : "s are"} due on or before ${day(end)} and hasn't run.`
    )
  );

  return checks;
}

/** The checklist for a period: computed checks, the company's own items, and what closing it would also close. */
export async function closeChecklist(ctx: Ctx, input: z.input<typeof PeriodIdSchema>): Promise<CloseChecklist> {
  requirePermission(ctx.actor, "read", "viewer", "read the close checklist");
  const p = await loadPeriod(ctx, PeriodIdSchema.parse(input).id);
  const org = ctx.actor.organizationId;
  const [checks, taskRows, earlier, [closer]] = await Promise.all([
    runChecks(ctx, p),
    ctx.tx
      .select({
        id: closeTasks.id,
        title: closeTasks.title,
        description: closeTasks.description,
        completedAt: closeTaskCompletions.completedAt,
        completedByEmail: profiles.email,
        note: closeTaskCompletions.note,
      })
      .from(closeTasks)
      .leftJoin(closeTaskCompletions, and(eq(closeTaskCompletions.taskId, closeTasks.id), eq(closeTaskCompletions.periodId, p.id)))
      .leftJoin(profiles, eq(profiles.id, closeTaskCompletions.completedBy))
      .where(and(eq(closeTasks.organizationId, org), eq(closeTasks.isActive, true)))
      .orderBy(asc(closeTasks.sortOrder), asc(closeTasks.createdAt)),
    ctx.tx
      .select({ code: fiscalPeriods.periodCode })
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.organizationId, org), eq(fiscalPeriods.status, "open"), lte(fiscalPeriods.endDate, p.startDate)))
      .orderBy(asc(fiscalPeriods.startDate)),
    p.closedBy ? ctx.tx.select({ email: profiles.email }).from(profiles).where(eq(profiles.id, p.closedBy)) : Promise.resolve([]),
  ]);
  const tasks = taskRows.map((t) => ({ ...t, done: t.completedAt !== null }));
  return {
    period: { ...p, closedByEmail: closer?.email ?? null },
    checks,
    tasks,
    openItems: checks.filter((c) => !c.ok).length + tasks.filter((t) => !t.done).length,
    alsoCloses: earlier.map((e) => e.code),
  };
}

// ---------------------------------------------------------------------------
// Close and reopen
// ---------------------------------------------------------------------------

export const ClosePeriodSchema = PeriodIdSchema.extend({
  level: z.enum(["soft", "hard"]).default("soft").describe("soft: only adjusting and reversing entries post. hard: nothing posts without the closing password."),
  note: optionalText().describe("Required when checklist items are open: why it's closing anyway."),
  password: z.string().max(200).optional().describe("The closing password. Required for a hard close."),
});

/**
 * Close the books through a period. Earlier periods still below the level
 * close with it. Closing the last period of a fiscal year hard closes the year.
 */
export async function closePeriod(ctx: Ctx, input: z.input<typeof ClosePeriodSchema>) {
  requirePermission(ctx.actor, "admin", "admin", "close a period");
  const f = ClosePeriodSchema.parse(input);
  const p = await loadPeriod(ctx, f.id);
  const userId = requirePerson(ctx.actor, "close a period");
  const org = ctx.actor.organizationId;
  const to: FiscalPeriod["status"] = f.level === "hard" ? "hard_closed" : "soft_closed";
  if (RANK[p.status] >= RANK[to]) throw new AppError("invalid_state", `${p.periodCode} is already ${p.status === "hard_closed" ? "hard closed" : "closed"}.`);
  if (f.level === "hard") await checkClosingPassword(ctx, f.password);

  const list = await closeChecklist(ctx, { id: p.id });
  const open = [...list.checks.filter((c) => !c.ok).map((c) => c.title), ...list.tasks.filter((t) => !t.done).map((t) => t.title)];
  if (open.length > 0 && !f.note) {
    throw new AppError("invalid_input", `${open.length} checklist item${open.length === 1 ? " is" : "s are"} open (${open.join(", ")}). Add a note to close anyway.`);
  }

  const affected = (
    await ctx.tx
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.organizationId, org), lte(fiscalPeriods.endDate, p.endDate)))
      .orderBy(asc(fiscalPeriods.startDate))
  ).filter((x) => RANK[x.status] < RANK[to]);
  for (const x of affected) {
    await ctx.tx
      .update(fiscalPeriods)
      .set({
        status: to,
        closedAt: sql`now()`,
        closedBy: userId,
        firstClosedAt: sql`COALESCE(${fiscalPeriods.firstClosedAt}, now())`,
        closeNote: x.id === p.id ? (f.note ?? null) : x.closeNote,
        updatedAt: sql`now()`,
      })
      .where(eq(fiscalPeriods.id, x.id));
    await writeAudit(
      {
        organizationId: org,
        ...auditFields(ctx.actor),
        event: `fiscal_period.${to}`,
        entityType: "fiscal_period",
        entityId: x.id,
        metadata: { code: x.periodCode, from: x.status, to, closedThrough: p.periodCode, openItems: x.id === p.id ? open : undefined, note: x.id === p.id ? f.note : undefined },
      },
      ctx.tx
    );
  }

  // The year closes when its last period is hard closed (and so, every period before it).
  let yearClosed: string | null = null;
  if (to === "hard_closed") {
    const years = await ctx.tx
      .select()
      .from(fiscalYears)
      .where(and(eq(fiscalYears.organizationId, org), eq(fiscalYears.status, "open"), lte(fiscalYears.endDate, p.endDate)));
    for (const y of years) {
      await ctx.tx.update(fiscalYears).set({ status: "closed", closedAt: sql`now()`, closedBy: userId, updatedAt: sql`now()` }).where(eq(fiscalYears.id, y.id));
      await writeAudit(
        { organizationId: org, ...auditFields(ctx.actor), event: "fiscal_year.closed", entityType: "fiscal_year", entityId: y.id, metadata: { yearLabel: y.yearLabel } },
        ctx.tx
      );
      yearClosed = y.yearLabel;
    }
  }
  return { closed: affected.map((x) => x.periodCode), status: to, yearClosed };
}

export const ReopenPeriodSchema = PeriodIdSchema.extend({
  reason: z.string().trim().min(1, "Say why the period is reopening.").max(2000),
  password: z.string().max(200).optional().describe("The closing password. Required when any period reopening is hard closed."),
});

/** Reopen a period and every closed period after it. */
export async function reopenPeriod(ctx: Ctx, input: z.input<typeof ReopenPeriodSchema>) {
  requirePermission(ctx.actor, "admin", "admin", "reopen a period");
  const f = ReopenPeriodSchema.parse(input);
  const p = await loadPeriod(ctx, f.id);
  requirePerson(ctx.actor, "reopen a period");
  const org = ctx.actor.organizationId;
  if (p.status === "open") throw new AppError("invalid_state", `${p.periodCode} is already open.`);
  const affected = await ctx.tx
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.organizationId, org), gte(fiscalPeriods.startDate, p.startDate), inArray(fiscalPeriods.status, ["soft_closed", "hard_closed"])))
    .orderBy(asc(fiscalPeriods.startDate));
  if (affected.some((x) => x.status === "hard_closed")) await checkClosingPassword(ctx, f.password);

  for (const x of affected) {
    await ctx.tx
      .update(fiscalPeriods)
      .set({ status: "open", closedAt: null, closedBy: null, closeNote: null, updatedAt: sql`now()` })
      .where(eq(fiscalPeriods.id, x.id));
    await writeAudit(
      {
        organizationId: org,
        ...auditFields(ctx.actor),
        event: "fiscal_period.reopened",
        entityType: "fiscal_period",
        entityId: x.id,
        metadata: { code: x.periodCode, from: x.status, reason: f.reason, reopenedFrom: p.periodCode },
      },
      ctx.tx
    );
  }
  const years = await ctx.tx
    .select()
    .from(fiscalYears)
    .where(and(eq(fiscalYears.organizationId, org), eq(fiscalYears.status, "closed"), gte(fiscalYears.endDate, p.startDate)));
  for (const y of years) {
    await ctx.tx.update(fiscalYears).set({ status: "open", closedAt: null, closedBy: null, updatedAt: sql`now()` }).where(eq(fiscalYears.id, y.id));
    await writeAudit(
      { organizationId: org, ...auditFields(ctx.actor), event: "fiscal_year.reopened", entityType: "fiscal_year", entityId: y.id, metadata: { yearLabel: y.yearLabel, reason: f.reason } },
      ctx.tx
    );
  }
  return { reopened: affected.map((x) => x.periodCode) };
}

// ---------------------------------------------------------------------------
// The company's checklist items
// ---------------------------------------------------------------------------

export const CreateCloseTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: optionalText(),
});

export const UpdateCloseTaskSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200).optional(),
  description: optionalText(),
  isActive: z.boolean().optional().describe("false retires the item from future checklists."),
});

export const SetCloseTaskSchema = PeriodIdSchema.extend({
  taskId: id,
  done: z.boolean().default(true),
  note: optionalText(),
});

export async function listCloseTasks(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "list close checklist items");
  return ctx.tx
    .select()
    .from(closeTasks)
    .where(eq(closeTasks.organizationId, ctx.actor.organizationId))
    .orderBy(asc(closeTasks.sortOrder), asc(closeTasks.createdAt));
}

export async function createCloseTask(ctx: Ctx, input: z.input<typeof CreateCloseTaskSchema>) {
  requirePermission(ctx.actor, "write", "accountant", "edit the close checklist");
  const d = CreateCloseTaskSchema.parse(input);
  const userId = requirePerson(ctx.actor, "edit the close checklist");
  const org = ctx.actor.organizationId;
  const [{ next }] = await ctx.tx
    .select({ next: sql<number>`COALESCE(MAX(${closeTasks.sortOrder}), 0) + 1` })
    .from(closeTasks)
    .where(eq(closeTasks.organizationId, org));
  const [t] = await ctx.tx
    .insert(closeTasks)
    .values({ organizationId: org, title: d.title, description: d.description ?? null, sortOrder: Number(next), createdBy: userId })
    .returning();
  await writeAudit(
    { organizationId: org, ...auditFields(ctx.actor), event: "close_task.created", entityType: "close_task", entityId: t.id, metadata: { name: t.title } },
    ctx.tx
  );
  return t;
}

export async function updateCloseTask(ctx: Ctx, input: z.input<typeof UpdateCloseTaskSchema>) {
  requirePermission(ctx.actor, "write", "accountant", "edit the close checklist");
  const d = UpdateCloseTaskSchema.parse(input);
  const org = ctx.actor.organizationId;
  const [t] = await ctx.tx.select().from(closeTasks).where(and(eq(closeTasks.id, d.id), eq(closeTasks.organizationId, org)));
  if (!t) throw notFound("Checklist item");
  requirePerson(ctx.actor, "edit the close checklist");
  const [u] = await ctx.tx
    .update(closeTasks)
    .set({
      title: d.title ?? t.title,
      description: d.description === undefined ? t.description : d.description,
      isActive: d.isActive ?? t.isActive,
      updatedAt: sql`now()`,
    })
    .where(eq(closeTasks.id, t.id))
    .returning();
  await writeAudit(
    { organizationId: org, ...auditFields(ctx.actor), event: "close_task.updated", entityType: "close_task", entityId: t.id, metadata: { name: u.title, isActive: u.isActive } },
    ctx.tx
  );
  return u;
}

/** Sign an item off for a period, or take the sign-off back. Not on a closed period. */
export async function setCloseTask(ctx: Ctx, input: z.input<typeof SetCloseTaskSchema>) {
  requirePermission(ctx.actor, "write", "bookkeeper", "sign off a close checklist item");
  const d = SetCloseTaskSchema.parse(input);
  const p = await loadPeriod(ctx, d.id);
  const org = ctx.actor.organizationId;
  const [t] = await ctx.tx.select().from(closeTasks).where(and(eq(closeTasks.id, d.taskId), eq(closeTasks.organizationId, org)));
  if (!t) throw notFound("Checklist item");
  const userId = requirePerson(ctx.actor, "sign off a close checklist item");
  if (p.status !== "open") throw new AppError("invalid_state", `${p.periodCode} is closed; reopen it to change its checklist.`);
  if (d.done) {
    await ctx.tx
      .insert(closeTaskCompletions)
      .values({ organizationId: org, periodId: p.id, taskId: t.id, completedBy: userId, note: d.note ?? null })
      .onConflictDoUpdate({ target: [closeTaskCompletions.periodId, closeTaskCompletions.taskId], set: { completedBy: userId, completedAt: sql`now()`, note: d.note ?? null } });
  } else {
    await ctx.tx.delete(closeTaskCompletions).where(and(eq(closeTaskCompletions.periodId, p.id), eq(closeTaskCompletions.taskId, t.id)));
  }
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: d.done ? "close_task.completed" : "close_task.reopened",
      entityType: "close_task",
      entityId: t.id,
      metadata: { name: t.title, code: p.periodCode, note: d.note },
    },
    ctx.tx
  );
  return { done: d.done };
}

// ---------------------------------------------------------------------------
// Closing password
// ---------------------------------------------------------------------------

export const SetClosingPasswordSchema = z.object({
  password: z.string().min(8, "Use at least 8 characters.").max(200),
  currentPassword: z.string().max(200).optional(),
});

/** Set or change the closing password. Owners only; changing it takes the current one. */
export async function setClosingPassword(ctx: Ctx, input: z.input<typeof SetClosingPasswordSchema>) {
  requirePermission(ctx.actor, "admin", "owner", "set the closing password");
  const d = SetClosingPasswordSchema.parse(input);
  requirePerson(ctx.actor, "set the closing password");
  const org = ctx.actor.organizationId;
  const [o] = await ctx.tx.select({ hash: organizations.hardCloseOverridePasswordHash }).from(organizations).where(eq(organizations.id, org));
  if (o?.hash) {
    if (!d.currentPassword || !(await verifyPassword(d.currentPassword, o.hash))) {
      throw new AppError("invalid_input", "The current closing password is wrong.");
    }
  }
  await ctx.tx.update(organizations).set({ hardCloseOverridePasswordHash: await hashPassword(d.password), updatedAt: sql`now()` }).where(eq(organizations.id, org));
  await writeAudit(
    { organizationId: org, ...auditFields(ctx.actor), event: o?.hash ? "company.closing_password_changed" : "company.closing_password_set", entityType: "organization", entityId: org },
    ctx.tx
  );
  return { set: true };
}

export async function hasClosingPassword(ctx: Ctx): Promise<boolean> {
  requirePermission(ctx.actor, "read", "viewer", "read close settings");
  const [o] = await ctx.tx.select({ hash: organizations.hardCloseOverridePasswordHash }).from(organizations).where(eq(organizations.id, ctx.actor.organizationId));
  return Boolean(o?.hash);
}

// ---------------------------------------------------------------------------
// Changes after close
// ---------------------------------------------------------------------------

export const ChangesAfterCloseSchema = z.object({ ...Range });

/**
 * Journals posted into a period after it was first closed: adjusting entries
 * in a soft-closed period, override posts into a hard-closed one, and
 * anything posted while a period was reopened. By journal date in the range.
 */
export async function changesAfterClose(ctx: Ctx, input: z.input<typeof ChangesAfterCloseSchema> = {}): Promise<ReportTable> {
  requirePermission(ctx.actor, "read", "viewer", "run the changes after close report");
  const { from, to } = range(ChangesAfterCloseSchema.parse(input));
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx.execute<{
    journal_number: string;
    description: string | null;
    journal_date: string;
    period_code: string;
    posted_at: Date;
    override_hard_close: boolean;
    override_reason: string | null;
    email: string | null;
    agent_name: string | null;
    amount: string;
  }>(sql`
    SELECT j.journal_number, j.description, j.journal_date::text, p.period_code, j.posted_at, j.override_hard_close, j.override_reason,
           pr.email, ag.name AS agent_name,
           (SELECT COALESCE(SUM(l.debit_local), 0) FROM gl_lines l WHERE l.journal_id = j.id)::text AS amount
      FROM gl_journals j
      JOIN fiscal_periods p ON p.id = j.period_id
      LEFT JOIN profiles pr ON pr.id = j.posted_by
      LEFT JOIN LATERAL (
        SELECT a.agent_id FROM audit_log a
         WHERE a.organization_id = j.organization_id AND a.entity_id = j.id
           AND a.event IN ('gl.journal.posted', 'gl.period.override_post')
         ORDER BY a.occurred_at LIMIT 1
      ) au ON true
      LEFT JOIN agents ag ON ag.id = au.agent_id AND ag.organization_id = j.organization_id
     WHERE j.organization_id = ${org}
       AND j.status IN ('posted', 'reversed')
       AND p.first_closed_at IS NOT NULL
       AND j.posted_at > p.first_closed_at
       AND j.journal_date BETWEEN ${from}::date AND ${to}::date
     ORDER BY j.posted_at, j.journal_number
  `);
  let total = money(0);
  const out: ReportRow[] = rows.map((r) => {
    total = total.plus(money(r.amount));
    const who = r.agent_name ? `${r.agent_name} (agent)` : (r.email ?? "System");
    return {
      kind: "account",
      label: `${r.journal_number}${r.description ? ` · ${r.description}` : ""}${r.override_hard_close ? ` (override${r.override_reason ? `: ${r.override_reason}` : ""})` : ""}`,
      values: [r.period_code, r.journal_date, new Date(r.posted_at).toISOString().slice(0, 16).replace("T", " "), who, fmt2(money(r.amount))],
    };
  });
  out.push({ kind: "total", label: `${rows.length} journal${rows.length === 1 ? "" : "s"}`, values: [null, null, null, null, fmt2(total)] });
  return {
    title: "Changes After Close",
    subtitle: rangeLabel(from, to),
    labelColumn: "Journal",
    columns: ["Period", "Date", "Posted (UTC)", "Who", "Amount"],
    columnKinds: ["number", "number", "text", "text", "money"],
    rows: out,
    notes: ["Journals posted into a period after it was first closed, including override posts and anything posted while it was reopened. Amount is the journal's total debits."],
  };
}

