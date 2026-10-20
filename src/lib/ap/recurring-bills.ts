import { format, parseISO, subDays } from "date-fns";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { apBills, recurringBillLines, recurringBills, vendors, type RecurringBill, type RecurringBillLine } from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, runAs, systemActor, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { FREQUENCIES, hasEnded, nextScheduleDate, RECURRING_TYPES } from "@/lib/ar/recurring-invoices";
import { AppError, invalidState, notFound, rethrowUnique } from "@/lib/errors";
import { requireLineAccounts } from "@/lib/gl/lookups";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { amount, currency, id, isoDate, likePattern, optionalText, pagination, positiveAmount, toPage, type Page } from "@/lib/schemas";
import { createBill, submitBill, type BillDetail, type CreateBillInput } from "./bills";

/**
 * RECURRING BILLS: a saved bill plus a schedule (rent, retainers, leases).
 *
 *   scheduled    the daily run creates the bill and submits it for approval
 *   reminder     the daily run creates a draft; it waits in the review queue
 *   unscheduled  only runs when someone uses it
 *
 * Same schedule rules as recurring invoices: each bill is created
 * `daysInAdvance` days ahead, dated on the schedule date; monthly and longer
 * schedules keep the start date's day of the month; the template ends after
 * its end date or its maximum number of bills. Bills still go through the
 * normal approval and posting, so a template never posts on its own.
 */

/** Most bills one template makes in one daily run (catching up after downtime). */
const MAX_CATCH_UP = 12;

const LineSchema = z.object({
  accountId: id.describe("Expense, asset, or COGS account to debit."),
  amount: positiveAmount,
  description: optionalText(500),
});

const TemplateFields = {
  name: z.string().trim().min(1).max(200).describe("Unique within the company, e.g. \"Office rent\"."),
  vendorId: id,
  type: z
    .enum(RECURRING_TYPES)
    .describe("scheduled: creates each bill and submits it for approval. reminder: creates a draft for review. unscheduled: never runs on its own."),
  frequency: z.enum(FREQUENCIES).default("monthly"),
  endDate: isoDate.nullable().optional().describe("Last date a bill may be dated. Optional."),
  maxOccurrences: z.number().int().min(1).max(1000).nullable().optional().describe("Stop after this many bills. Optional."),
  daysInAdvance: z.number().int().min(0).max(90).default(0).describe("Create each bill this many days before its date."),
  currency: currency.optional().describe("Defaults to the vendor's currency."),
  exchangeRate: amount.optional(),
  description: optionalText(500),
  notes: optionalText(),
  lines: z.array(LineSchema).min(1, "A recurring bill needs at least 1 line."),
};

export const CreateRecurringBillSchema = z
  .object({
    ...TemplateFields,
    startDate: isoDate.optional().describe("Date of the first bill. Required unless unscheduled."),
  })
  .refine((d) => d.type === "unscheduled" || d.startDate, { message: "startDate is required for scheduled and reminder templates." });
export type CreateRecurringBillInput = z.input<typeof CreateRecurringBillSchema>;

export const UpdateRecurringBillSchema = z.object({
  id,
  ...TemplateFields,
  nextRunDate: isoDate.optional().describe("Date of the next bill. Defaults to the current schedule."),
});
export type UpdateRecurringBillInput = z.input<typeof UpdateRecurringBillSchema>;

export const ListRecurringBillsSchema = z.object({
  status: z.enum(["active", "paused", "ended"]).optional(),
  type: z.enum(RECURRING_TYPES).optional(),
  vendorId: id.optional(),
  q: z.string().trim().max(200).optional().describe("Search template name or vendor name."),
  ...pagination,
});

export const SetRecurringBillStatusSchema = z.object({
  id,
  status: z.enum(["active", "paused"]).describe("paused stops the schedule; active resumes it from the next date on or after today."),
});

export const UseRecurringBillSchema = z.object({
  id,
  billDate: isoDate.optional().describe("Defaults to today. The schedule isn't touched."),
  vendorInvoiceNumber: optionalText(100),
  submit: z.boolean().optional().describe("Submit the bill for approval in the same call. Without this it stays a draft."),
});

const IdSchema = z.object({ id });

export type RecurringBillRow = RecurringBill & { vendorName: string };
export type RecurringBillDetail = RecurringBillRow & {
  lines: RecurringBillLine[];
  bills: Array<{ id: string; billNumber: string; billDate: string; status: string; totalAmount: string }>;
};

function today() {
  return format(new Date(), "yyyy-MM-dd");
}

function requireNotPast(date: string, label: string) {
  if (date < format(subDays(new Date(), 1), "yyyy-MM-dd")) {
    throw new AppError("invalid_input", `${label} can't be in the past. Enter past bills directly.`);
  }
}

export async function listRecurringBills(ctx: Ctx, input: z.input<typeof ListRecurringBillsSchema>): Promise<Page<RecurringBillRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list recurring bills");
  const f = ListRecurringBillsSchema.parse(input);
  const rows = await ctx.tx
    .select({ t: recurringBills, vendorName: vendors.name })
    .from(recurringBills)
    .innerJoin(vendors, eq(vendors.id, recurringBills.vendorId))
    .where(
      and(
        eq(recurringBills.organizationId, ctx.actor.organizationId),
        isNull(recurringBills.deletedAt),
        f.status ? eq(recurringBills.status, f.status) : undefined,
        f.type ? eq(recurringBills.type, f.type) : undefined,
        f.vendorId ? eq(recurringBills.vendorId, f.vendorId) : undefined,
        f.q ? or(ilike(recurringBills.name, likePattern(f.q)), ilike(vendors.name, likePattern(f.q))) : undefined
      )
    )
    .orderBy(asc(recurringBills.name))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map((r) => ({ ...r.t, vendorName: r.vendorName })), f.limit, f.offset);
}

async function loadTemplate(ctx: Ctx, templateId: string, lock = false): Promise<RecurringBill> {
  const q = ctx.tx
    .select()
    .from(recurringBills)
    .where(and(eq(recurringBills.id, templateId), eq(recurringBills.organizationId, ctx.actor.organizationId), isNull(recurringBills.deletedAt)));
  const [t] = lock ? await q.for("update") : await q;
  if (!t) throw notFound("Recurring bill");
  return t;
}

async function templateLines(ctx: Ctx, templateId: string) {
  return ctx.tx.select().from(recurringBillLines).where(eq(recurringBillLines.recurringBillId, templateId)).orderBy(asc(recurringBillLines.lineNumber));
}

export async function getRecurringBill(ctx: Ctx, input: { id: string }): Promise<RecurringBillDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view recurring bills");
  const { id: templateId } = IdSchema.parse(input);
  const t = await loadTemplate(ctx, templateId);
  const [v] = await ctx.tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, t.vendorId));
  const bills = await ctx.tx
    .select({ id: apBills.id, billNumber: apBills.billNumber, billDate: apBills.billDate, status: apBills.status, totalAmount: apBills.totalAmount })
    .from(apBills)
    .where(and(eq(apBills.organizationId, ctx.actor.organizationId), eq(apBills.recurringBillId, t.id), isNull(apBills.deletedAt)))
    .orderBy(desc(apBills.billDate), desc(apBills.billNumber))
    .limit(50);
  return { ...t, vendorName: v?.name ?? "", lines: await templateLines(ctx, t.id), bills };
}

async function resolveTemplate(ctx: Ctx, d: z.output<typeof CreateRecurringBillSchema> | z.output<typeof UpdateRecurringBillSchema>) {
  const org = ctx.actor.organizationId;
  const [vendor] = await ctx.tx.select().from(vendors).where(and(eq(vendors.id, d.vendorId), eq(vendors.organizationId, org)));
  if (!vendor) throw notFound("Vendor");
  if (!vendor.isActive) throw new AppError("invalid_input", `Vendor ${vendor.name} is inactive.`);
  await requireLineAccounts(ctx.tx, org, d.lines.map((l) => l.accountId));
  return {
    header: {
      name: d.name,
      vendorId: vendor.id,
      type: d.type,
      frequency: d.frequency,
      endDate: d.endDate ?? null,
      maxOccurrences: d.maxOccurrences ?? null,
      daysInAdvance: d.daysInAdvance,
      currency: d.currency ?? vendor.currency,
      exchangeRate: d.exchangeRate ?? "1",
      totalAmount: toDbMoney(sumMoney(d.lines.map((l) => l.amount))),
      description: d.description,
      notes: d.notes,
    },
    lines: d.lines,
  };
}

async function insertLines(ctx: Ctx, recurringBillId: string, lines: z.output<typeof LineSchema>[]) {
  await ctx.tx.insert(recurringBillLines).values(
    lines.map((l, i) => ({
      organizationId: ctx.actor.organizationId,
      recurringBillId,
      lineNumber: i + 1,
      accountId: l.accountId,
      amount: l.amount,
      description: l.description,
    }))
  );
}

async function audit(ctx: Ctx, event: string, t: Pick<RecurringBill, "id" | "name">, metadata: Record<string, unknown> = {}) {
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: `ap.recurring_bill.${event}`,
      entityType: "recurring_bill",
      entityId: t.id,
      metadata: { name: t.name, ...metadata },
    },
    ctx.tx
  );
}

export async function createRecurringBill(ctx: Ctx, input: CreateRecurringBillInput): Promise<RecurringBillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create recurring bills");
  const d = CreateRecurringBillSchema.parse(input);
  const { header, lines } = await resolveTemplate(ctx, d);
  const scheduled = d.type !== "unscheduled";
  if (scheduled) requireNotPast(d.startDate!, "The first bill date");
  if (scheduled && d.endDate && d.endDate < d.startDate!) throw new AppError("invalid_input", "The end date can't be before the first bill date.");
  const startDate = d.startDate ?? today();
  let t: RecurringBill;
  try {
    [t] = await ctx.tx
      .insert(recurringBills)
      .values({
        organizationId: ctx.actor.organizationId,
        ...header,
        startDate,
        nextRunDate: scheduled ? startDate : null,
        status: "active",
        ...creatorFields(ctx.actor),
      })
      .returning();
  } catch (err) {
    rethrowUnique(err, `A recurring bill named "${d.name}" already exists.`);
  }
  await insertLines(ctx, t.id, lines);
  await audit(ctx, "created", t, { vendorId: t.vendorId, type: t.type, frequency: t.frequency, nextRunDate: t.nextRunDate, total: t.totalAmount });
  return getRecurringBill(ctx, { id: t.id });
}

export async function updateRecurringBill(ctx: Ctx, input: UpdateRecurringBillInput): Promise<RecurringBillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit recurring bills");
  const d = UpdateRecurringBillSchema.parse(input);
  const t = await loadTemplate(ctx, d.id, true);
  const { header, lines } = await resolveTemplate(ctx, d);
  const scheduled = d.type !== "unscheduled";
  let nextRunDate: string | null = null;
  let startDate = t.startDate;
  if (scheduled) {
    nextRunDate = d.nextRunDate ?? t.nextRunDate;
    if (!nextRunDate) throw new AppError("invalid_input", "nextRunDate is required to put this template on a schedule.");
    if (nextRunDate !== t.nextRunDate) {
      requireNotPast(nextRunDate, "The next bill date");
      // A new date is a new anchor for the day of the month.
      startDate = nextRunDate;
    }
    if (d.endDate && d.endDate < nextRunDate) throw new AppError("invalid_input", "The end date can't be before the next bill date.");
  }
  const ended = scheduled && hasEnded({ ...header, occurrences: t.occurrences }, nextRunDate);
  const status = ended ? "ended" : t.status === "ended" ? "active" : t.status;
  try {
    await ctx.tx
      .update(recurringBills)
      .set({ ...header, startDate, nextRunDate, status, updatedAt: sql`now()` })
      .where(eq(recurringBills.id, t.id));
  } catch (err) {
    rethrowUnique(err, `A recurring bill named "${d.name}" already exists.`);
  }
  await ctx.tx.delete(recurringBillLines).where(eq(recurringBillLines.recurringBillId, t.id));
  await insertLines(ctx, t.id, lines);
  await audit(ctx, "updated", { id: t.id, name: d.name }, { type: d.type, frequency: d.frequency, nextRunDate, status, total: header.totalAmount });
  return getRecurringBill(ctx, { id: t.id });
}

export async function setRecurringBillStatus(ctx: Ctx, input: z.input<typeof SetRecurringBillStatusSchema>): Promise<RecurringBillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "pause or resume recurring bills");
  const d = SetRecurringBillStatusSchema.parse(input);
  const t = await loadTemplate(ctx, d.id, true);
  if (t.status === "ended") throw invalidState(`"${t.name}" has ended. Edit its end date or limit to run it again.`);
  let nextRunDate = t.nextRunDate;
  let status: RecurringBill["status"] = d.status;
  if (d.status === "active" && nextRunDate) {
    // Resuming skips the dates missed while paused instead of billing them all at once.
    const now = today();
    for (let i = 0; nextRunDate < now && i < 10000; i++) nextRunDate = nextScheduleDate(nextRunDate, t.frequency, t.startDate);
    if (hasEnded(t, nextRunDate)) status = "ended";
  }
  await ctx.tx.update(recurringBills).set({ status, nextRunDate, updatedAt: sql`now()` }).where(eq(recurringBills.id, t.id));
  await audit(ctx, d.status === "active" ? "resumed" : "paused", t, { status, nextRunDate });
  return getRecurringBill(ctx, { id: t.id });
}

export async function deleteRecurringBill(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete recurring bills");
  const { id: templateId } = IdSchema.parse(input);
  const t = await loadTemplate(ctx, templateId, true);
  // Bills it already made stay; they just stop pointing at it.
  await ctx.tx.delete(recurringBills).where(eq(recurringBills.id, t.id));
  await audit(ctx, "deleted", t, { occurrences: t.occurrences });
  return { id: t.id };
}

function billInput(t: RecurringBill, lines: RecurringBillLine[], billDate: string, vendorInvoiceNumber?: string): CreateBillInput {
  return {
    vendorId: t.vendorId,
    billDate,
    vendorInvoiceNumber,
    currency: t.currency,
    // Stored with 10 places; the rate itself came in with at most 4.
    exchangeRate: money(t.exchangeRate).toString(),
    description: t.description ?? t.name,
    notes: t.notes ?? undefined,
    lines: lines.map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description })),
  };
}

/** Make a bill from the template now, off schedule. */
export async function createBillFromRecurring(ctx: Ctx, input: z.input<typeof UseRecurringBillSchema>): Promise<BillDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create bills");
  const d = UseRecurringBillSchema.parse(input);
  const t = await loadTemplate(ctx, d.id);
  let bill = await createBill(ctx, billInput(t, await templateLines(ctx, t.id), d.billDate ?? today(), d.vendorInvoiceNumber ?? undefined), {
    recurringBillId: t.id,
  });
  if (d.submit) bill = await submitBill(ctx, { id: bill.id });
  await audit(ctx, "used", t, { billId: bill.id, billNumber: bill.billNumber });
  return bill;
}

// ---------------------------------------------------------------------------
// The daily run
// ---------------------------------------------------------------------------

export type RecurringBillRunResult = {
  checked: number;
  created: number;
  submitted: number;
  errors: Array<{ recurringBillId: string; name: string; error: string }>;
};

/** Create (and for scheduled templates, submit) every bill due by `asOfDate`. One transaction per template. */
export async function runRecurringBillsForOrg(organizationId: string, asOfDate: string): Promise<RecurringBillRunResult> {
  const due = await db
    .select({ id: recurringBills.id, name: recurringBills.name })
    .from(recurringBills)
    .where(
      and(
        eq(recurringBills.organizationId, organizationId),
        eq(recurringBills.status, "active"),
        inArray(recurringBills.type, ["scheduled", "reminder"]),
        isNotNull(recurringBills.nextRunDate),
        isNull(recurringBills.deletedAt),
        lte(sql`${recurringBills.nextRunDate} - ${recurringBills.daysInAdvance}`, sql`${asOfDate}::date`)
      )
    );
  const result: RecurringBillRunResult = { checked: due.length, created: 0, submitted: 0, errors: [] };
  const actor = systemActor(organizationId);
  for (const t of due) {
    try {
      const r = await runAs(actor, (ctx) => runTemplate(ctx, t.id, asOfDate));
      result.created += r.created;
      result.submitted += r.submitted;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push({ recurringBillId: t.id, name: t.name, error: message });
      // A template deleted mid-run has nowhere to record it; the rest still run.
      await runAs(actor, (ctx) => recordFailure(ctx, t.id, message)).catch(() => undefined);
    }
  }
  return result;
}

async function runTemplate(ctx: Ctx, templateId: string, asOfDate: string): Promise<{ created: number; submitted: number }> {
  let created = 0;
  let submitted = 0;
  for (let i = 0; i < MAX_CATCH_UP; i++) {
    const t = await loadTemplate(ctx, templateId, true);
    if (t.status !== "active" || t.type === "unscheduled" || !t.nextRunDate) break;
    if (format(subDays(parseISO(t.nextRunDate), t.daysInAdvance), "yyyy-MM-dd") > asOfDate) break;

    const bill = await createBill(ctx, billInput(t, await templateLines(ctx, t.id), t.nextRunDate), { recurringBillId: t.id });
    created++;
    let error: string | null = null;
    if (t.type === "scheduled") {
      try {
        // Savepoint: a refused submit keeps the draft for review.
        await ctx.tx.transaction((sp) => submitBill({ actor: ctx.actor, tx: sp }, { id: bill.id }));
        submitted++;
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        error = `Created ${bill.billNumber} but couldn't submit it: ${e.message}`;
      }
    }
    const occurrences = t.occurrences + 1;
    const next = nextScheduleDate(t.nextRunDate, t.frequency, t.startDate);
    const ended = hasEnded({ ...t, occurrences }, next);
    await ctx.tx
      .update(recurringBills)
      .set({
        occurrences,
        lastRunDate: t.nextRunDate,
        lastBillId: bill.id,
        lastError: error,
        nextRunDate: next,
        status: ended ? "ended" : "active",
        updatedAt: sql`now()`,
      })
      .where(eq(recurringBills.id, t.id));
    await audit(ctx, "ran", t, {
      billId: bill.id,
      billNumber: bill.billNumber,
      billDate: t.nextRunDate,
      submitted: t.type === "scheduled" && !error,
      ...(error ? { error } : {}),
      ...(ended ? { ended: true } : {}),
    });
  }
  return { created, submitted };
}

async function recordFailure(ctx: Ctx, templateId: string, message: string) {
  const t = await loadTemplate(ctx, templateId, true);
  await ctx.tx.update(recurringBills).set({ lastError: message, updatedAt: sql`now()` }).where(eq(recurringBills.id, t.id));
  await audit(ctx, "failed", t, { nextRunDate: t.nextRunDate, error: message });
}
