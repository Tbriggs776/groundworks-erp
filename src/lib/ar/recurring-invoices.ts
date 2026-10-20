import { endOfMonth, format, parseISO, setDate, subDays } from "date-fns";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  arInvoices,
  customers,
  items,
  recurringInvoiceLines,
  recurringInvoices,
  type RecurringInvoice,
  type RecurringInvoiceLine,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, runAs, systemActor, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound, rethrowUnique } from "@/lib/errors";
import { advanceRecurringDate } from "@/lib/gl/recurring";
import { money } from "@/lib/money";
import { requireActiveCustomer } from "@/lib/parties/service";
import { type ReviewNotice } from "@/lib/review-policy";
import { amount, currency, id, isoDate, likePattern, optionalText, pagination, toPage, type Page } from "@/lib/schemas";
import { documentTotals, resolveSalesLines, SalesLineSchema, taxCodeField, totalsColumns, type ResolvedLine } from "./documents";
import { createInvoice, postInvoice, type CreateInvoiceInput, type InvoiceDetail } from "./invoices";

/**
 * RECURRING INVOICES: a saved invoice plus a schedule.
 *
 *   scheduled    the daily run creates the invoice and posts it
 *   reminder     the daily run creates a draft; it waits in the review queue
 *   unscheduled  only runs when someone uses it
 *
 * The run creates each invoice `daysInAdvance` days ahead, dated on the
 * schedule date, then moves the schedule on. Monthly and longer schedules
 * keep the start date's day of the month (the 31st falls back to the last
 * day in short months). The template ends after its end date or its
 * maximum number of invoices.
 *
 * Agents may make reminder and unscheduled templates freely. A scheduled
 * template posts with nobody watching, so an agent needs the post scope
 * and a posting limit that covers the invoice to make one.
 */

export const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "quarterly", "semiannually", "annually"] as const;
export const RECURRING_TYPES = ["scheduled", "reminder", "unscheduled"] as const;
type Frequency = (typeof FREQUENCIES)[number];

/** Most invoices one template makes in one daily run (catching up after downtime). */
const MAX_CATCH_UP = 12;

const TemplateFields = {
  name: z.string().trim().min(1).max(200).describe("Unique within the company, e.g. \"Acme monthly retainer\"."),
  customerId: id,
  type: z
    .enum(RECURRING_TYPES)
    .describe("scheduled: creates and posts each invoice. reminder: creates a draft for review. unscheduled: never runs on its own."),
  frequency: z.enum(FREQUENCIES).default("monthly"),
  endDate: isoDate.nullable().optional().describe("Last date an invoice may be dated. Optional."),
  maxOccurrences: z.number().int().min(1).max(1000).nullable().optional().describe("Stop after this many invoices. Optional."),
  daysInAdvance: z.number().int().min(0).max(90).default(0).describe("Create each invoice this many days before its date."),
  poNumber: optionalText(100),
  currency: currency.optional().describe("Defaults to the customer's currency."),
  exchangeRate: amount.optional(),
  taxCodeId: taxCodeField,
  memo: optionalText(2000).describe("Message shown to the customer on each invoice."),
  privateNote: optionalText(2000),
  lines: z.array(SalesLineSchema).min(1, "A recurring invoice needs at least 1 line."),
};

export const CreateRecurringInvoiceSchema = z
  .object({
    ...TemplateFields,
    startDate: isoDate.optional().describe("Date of the first invoice. Required unless unscheduled."),
  })
  .refine((d) => d.type === "unscheduled" || d.startDate, { message: "startDate is required for scheduled and reminder templates." });
export type CreateRecurringInvoiceInput = z.input<typeof CreateRecurringInvoiceSchema>;

export const UpdateRecurringInvoiceSchema = z.object({
  id,
  ...TemplateFields,
  nextRunDate: isoDate.optional().describe("Date of the next invoice. Defaults to the current schedule."),
});
export type UpdateRecurringInvoiceInput = z.input<typeof UpdateRecurringInvoiceSchema>;

export const ListRecurringInvoicesSchema = z.object({
  status: z.enum(["active", "paused", "ended"]).optional(),
  type: z.enum(RECURRING_TYPES).optional(),
  customerId: id.optional(),
  q: z.string().trim().max(200).optional().describe("Search template name or customer name."),
  ...pagination,
});

export const SetRecurringStatusSchema = z.object({
  id,
  status: z.enum(["active", "paused"]).describe("paused stops the schedule; active resumes it from the next date on or after today."),
});

export const UseRecurringInvoiceSchema = z.object({
  id,
  invoiceDate: isoDate.optional().describe("Defaults to today. The schedule isn't touched."),
  post: z.boolean().optional().describe("Post the invoice in the same call. Without this it stays a draft."),
});

const IdSchema = z.object({ id });

export type RecurringInvoiceRow = RecurringInvoice & { customerName: string };
export type RecurringInvoiceDetail = RecurringInvoiceRow & {
  lines: Array<RecurringInvoiceLine & { itemName: string | null }>;
  invoices: Array<{ id: string; invoiceNumber: string; invoiceDate: string; status: string; totalAmount: string }>;
};

function today() {
  return format(new Date(), "yyyy-MM-dd");
}

/** One schedule step. Monthly and longer keep the anchor's day of the month. */
export function nextScheduleDate(date: string, frequency: Frequency, anchor: string): string {
  const next = advanceRecurringDate(parseISO(date), frequency);
  if (frequency === "daily" || frequency === "weekly" || frequency === "biweekly") return format(next, "yyyy-MM-dd");
  const day = Math.min(parseISO(anchor).getDate(), endOfMonth(next).getDate());
  return format(setDate(next, day), "yyyy-MM-dd");
}

function hasEnded(t: Pick<RecurringInvoice, "endDate" | "maxOccurrences" | "occurrences">, next: string | null) {
  return Boolean((t.endDate && next && next > t.endDate) || (t.maxOccurrences !== null && t.occurrences >= t.maxOccurrences));
}

/** A scheduled template posts on its own later, so an agent must be allowed to post it now. */
function requireCanSchedule(ctx: Ctx, type: RecurringInvoice["type"], total: string, exchangeRate: string) {
  if (type !== "scheduled" || ctx.actor.kind !== "agent") return;
  requirePermission(ctx.actor, "post", "bookkeeper", "schedule invoices that post on their own");
  const amt = money(total).times(money(exchangeRate));
  if (ctx.actor.maxPostAmount !== null && amt.gt(money(ctx.actor.maxPostAmount))) {
    throw new AppError(
      "forbidden",
      `Each invoice would be ${amt.toFixed(2)}, above this agent's posting limit of ${money(ctx.actor.maxPostAmount).toFixed(2)}. Make it a reminder so each invoice waits for review.`
    );
  }
}

function requireNotPast(date: string, label: string) {
  if (date < format(subDays(new Date(), 1), "yyyy-MM-dd")) {
    throw new AppError("invalid_input", `${label} can't be in the past. Create past invoices directly.`);
  }
}

const customerName = sql<string>`(SELECT c.name FROM customers c WHERE c.id = "recurring_invoices"."customer_id")`;

export async function listRecurringInvoices(
  ctx: Ctx,
  input: z.input<typeof ListRecurringInvoicesSchema>
): Promise<Page<RecurringInvoiceRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list recurring invoices");
  const f = ListRecurringInvoicesSchema.parse(input);
  const rows = await ctx.tx
    .select({ t: recurringInvoices, customerName: customers.name })
    .from(recurringInvoices)
    .innerJoin(customers, eq(customers.id, recurringInvoices.customerId))
    .where(
      and(
        eq(recurringInvoices.organizationId, ctx.actor.organizationId),
        isNull(recurringInvoices.deletedAt),
        f.status ? eq(recurringInvoices.status, f.status) : undefined,
        f.type ? eq(recurringInvoices.type, f.type) : undefined,
        f.customerId ? eq(recurringInvoices.customerId, f.customerId) : undefined,
        f.q ? or(ilike(recurringInvoices.name, likePattern(f.q)), ilike(customers.name, likePattern(f.q))) : undefined
      )
    )
    .orderBy(asc(recurringInvoices.name))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows.map((r) => ({ ...r.t, customerName: r.customerName })), f.limit, f.offset);
}

async function loadTemplate(ctx: Ctx, templateId: string, lock = false): Promise<RecurringInvoice> {
  const q = ctx.tx
    .select()
    .from(recurringInvoices)
    .where(
      and(
        eq(recurringInvoices.id, templateId),
        eq(recurringInvoices.organizationId, ctx.actor.organizationId),
        isNull(recurringInvoices.deletedAt)
      )
    );
  const [t] = lock ? await q.for("update") : await q;
  if (!t) throw notFound("Recurring invoice");
  return t;
}

async function templateLines(ctx: Ctx, templateId: string) {
  return ctx.tx
    .select()
    .from(recurringInvoiceLines)
    .where(eq(recurringInvoiceLines.recurringInvoiceId, templateId))
    .orderBy(asc(recurringInvoiceLines.lineNumber));
}

export async function getRecurringInvoice(ctx: Ctx, input: { id: string }): Promise<RecurringInvoiceDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view recurring invoices");
  const { id: templateId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select({ t: recurringInvoices, customerName })
    .from(recurringInvoices)
    .where(
      and(
        eq(recurringInvoices.id, templateId),
        eq(recurringInvoices.organizationId, ctx.actor.organizationId),
        isNull(recurringInvoices.deletedAt)
      )
    );
  if (!row) throw notFound("Recurring invoice");
  const lines = await ctx.tx
    .select({ line: recurringInvoiceLines, itemName: items.name })
    .from(recurringInvoiceLines)
    .leftJoin(items, eq(items.id, recurringInvoiceLines.itemId))
    .where(eq(recurringInvoiceLines.recurringInvoiceId, templateId))
    .orderBy(asc(recurringInvoiceLines.lineNumber));
  const invoices = await ctx.tx
    .select({
      id: arInvoices.id,
      invoiceNumber: arInvoices.invoiceNumber,
      invoiceDate: arInvoices.invoiceDate,
      status: arInvoices.status,
      totalAmount: arInvoices.totalAmount,
    })
    .from(arInvoices)
    .where(and(eq(arInvoices.organizationId, ctx.actor.organizationId), eq(arInvoices.recurringInvoiceId, templateId), isNull(arInvoices.deletedAt)))
    .orderBy(desc(arInvoices.invoiceDate), desc(arInvoices.invoiceNumber))
    .limit(50);
  return {
    ...row.t,
    customerName: row.customerName,
    lines: lines.map((l) => ({ ...l.line, itemName: l.itemName })),
    invoices,
  };
}

async function resolveTemplate(ctx: Ctx, d: z.output<typeof CreateRecurringInvoiceSchema> | z.output<typeof UpdateRecurringInvoiceSchema>) {
  const customer = await requireActiveCustomer(ctx, d.customerId);
  const lines = await resolveSalesLines(ctx, d.lines);
  const totals = await documentTotals(ctx, { customer, taxCodeId: d.taxCodeId, lines });
  const exchangeRate = d.exchangeRate ?? "1";
  requireCanSchedule(ctx, d.type, totals.totalAmount, exchangeRate);
  return {
    header: {
      name: d.name,
      customerId: customer.id,
      type: d.type,
      frequency: d.frequency,
      endDate: d.endDate ?? null,
      maxOccurrences: d.maxOccurrences ?? null,
      daysInAdvance: d.daysInAdvance,
      poNumber: d.poNumber,
      currency: d.currency ?? customer.currency,
      exchangeRate,
      ...totalsColumns(totals),
      memo: d.memo,
      privateNote: d.privateNote,
    },
    lines,
  };
}

async function insertLines(ctx: Ctx, recurringInvoiceId: string, lines: ResolvedLine[]) {
  await ctx.tx
    .insert(recurringInvoiceLines)
    .values(lines.map((l, i) => ({ organizationId: ctx.actor.organizationId, recurringInvoiceId, lineNumber: i + 1, ...l })));
}

export async function createRecurringInvoice(ctx: Ctx, input: CreateRecurringInvoiceInput): Promise<RecurringInvoiceDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create recurring invoices");
  const d = CreateRecurringInvoiceSchema.parse(input);
  const org = ctx.actor.organizationId;
  const { header, lines } = await resolveTemplate(ctx, d);
  const scheduled = d.type !== "unscheduled";
  if (scheduled) requireNotPast(d.startDate!, "The first invoice date");
  if (scheduled && d.endDate && d.endDate < d.startDate!) throw new AppError("invalid_input", "The end date can't be before the first invoice date.");
  const startDate = d.startDate ?? today();
  let t: RecurringInvoice;
  try {
    [t] = await ctx.tx
      .insert(recurringInvoices)
      .values({
        organizationId: org,
        ...header,
        startDate,
        nextRunDate: scheduled ? startDate : null,
        status: "active",
        ...creatorFields(ctx.actor),
      })
      .returning();
  } catch (err) {
    rethrowUnique(err, `A recurring invoice named "${d.name}" already exists.`);
  }
  await insertLines(ctx, t.id, lines);
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ar.recurring_invoice.created",
      entityType: "recurring_invoice",
      entityId: t.id,
      metadata: { name: t.name, customerId: t.customerId, type: t.type, frequency: t.frequency, nextRunDate: t.nextRunDate, total: t.totalAmount },
    },
    ctx.tx
  );
  return getRecurringInvoice(ctx, { id: t.id });
}

export async function updateRecurringInvoice(ctx: Ctx, input: UpdateRecurringInvoiceInput): Promise<RecurringInvoiceDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "edit recurring invoices");
  const d = UpdateRecurringInvoiceSchema.parse(input);
  const t = await loadTemplate(ctx, d.id, true);
  const { header, lines } = await resolveTemplate(ctx, d);
  const scheduled = d.type !== "unscheduled";
  let nextRunDate: string | null = null;
  let startDate = t.startDate;
  if (scheduled) {
    nextRunDate = d.nextRunDate ?? t.nextRunDate;
    if (!nextRunDate) throw new AppError("invalid_input", "nextRunDate is required to put this template on a schedule.");
    if (nextRunDate !== t.nextRunDate) {
      requireNotPast(nextRunDate, "The next invoice date");
      // A new date is a new anchor for the day of the month.
      startDate = nextRunDate;
    }
    if (d.endDate && d.endDate < nextRunDate) throw new AppError("invalid_input", "The end date can't be before the next invoice date.");
  }
  const ended = scheduled && hasEnded({ ...header, occurrences: t.occurrences }, nextRunDate);
  const status = ended ? "ended" : t.status === "ended" ? "active" : t.status;
  try {
    await ctx.tx
      .update(recurringInvoices)
      .set({ ...header, startDate, nextRunDate, status, updatedAt: sql`now()` })
      .where(eq(recurringInvoices.id, t.id));
  } catch (err) {
    rethrowUnique(err, `A recurring invoice named "${d.name}" already exists.`);
  }
  await ctx.tx.delete(recurringInvoiceLines).where(eq(recurringInvoiceLines.recurringInvoiceId, t.id));
  await insertLines(ctx, t.id, lines);
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.recurring_invoice.updated",
      entityType: "recurring_invoice",
      entityId: t.id,
      metadata: { name: d.name, type: d.type, frequency: d.frequency, nextRunDate, status, total: header.totalAmount },
    },
    ctx.tx
  );
  return getRecurringInvoice(ctx, { id: t.id });
}

export async function setRecurringInvoiceStatus(ctx: Ctx, input: z.input<typeof SetRecurringStatusSchema>): Promise<RecurringInvoiceDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "pause or resume recurring invoices");
  const d = SetRecurringStatusSchema.parse(input);
  const t = await loadTemplate(ctx, d.id, true);
  if (t.status === "ended") throw invalidState(`"${t.name}" has ended. Edit its end date or limit to run it again.`);
  let nextRunDate = t.nextRunDate;
  let status: RecurringInvoice["status"] = d.status;
  if (d.status === "active") {
    requireCanSchedule(ctx, t.type, t.totalAmount, t.exchangeRate);
    // Resuming skips the dates missed while paused instead of billing them all at once.
    if (nextRunDate) {
      const now = today();
      for (let i = 0; nextRunDate < now && i < 10000; i++) nextRunDate = nextScheduleDate(nextRunDate, t.frequency, t.startDate);
      if (hasEnded(t, nextRunDate)) status = "ended";
    }
  }
  await ctx.tx.update(recurringInvoices).set({ status, nextRunDate, updatedAt: sql`now()` }).where(eq(recurringInvoices.id, t.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: d.status === "active" ? "ar.recurring_invoice.resumed" : "ar.recurring_invoice.paused",
      entityType: "recurring_invoice",
      entityId: t.id,
      metadata: { name: t.name, status, nextRunDate },
    },
    ctx.tx
  );
  return getRecurringInvoice(ctx, { id: t.id });
}

export async function deleteRecurringInvoice(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete recurring invoices");
  const { id: templateId } = IdSchema.parse(input);
  const t = await loadTemplate(ctx, templateId, true);
  // Invoices it already made stay; they just stop pointing at it.
  await ctx.tx.delete(recurringInvoices).where(eq(recurringInvoices.id, t.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.recurring_invoice.deleted",
      entityType: "recurring_invoice",
      entityId: t.id,
      metadata: { name: t.name, occurrences: t.occurrences },
    },
    ctx.tx
  );
  return { id: t.id };
}

function invoiceInput(t: RecurringInvoice, lines: RecurringInvoiceLine[], invoiceDate: string, post: boolean): CreateInvoiceInput {
  return {
    customerId: t.customerId,
    invoiceDate,
    poNumber: t.poNumber ?? undefined,
    currency: t.currency,
    // Stored with 10 places; the rate itself came in with at most 4.
    exchangeRate: money(t.exchangeRate).toString(),
    taxCodeId: t.taxCodeId,
    memo: t.memo ?? undefined,
    privateNote: t.privateNote ?? undefined,
    lines: lines.map((l) => ({
      itemId: l.itemId ?? undefined,
      description: l.description ?? undefined,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      accountId: l.accountId,
      taxable: l.taxable,
      dimensions: l.dimensions,
    })),
    post,
  };
}

/** Make an invoice from the template now, off schedule. */
export async function createInvoiceFromRecurring(
  ctx: Ctx,
  input: z.input<typeof UseRecurringInvoiceSchema>
): Promise<InvoiceDetail & Partial<ReviewNotice>> {
  requirePermission(ctx.actor, "write", "bookkeeper", "create invoices");
  const d = UseRecurringInvoiceSchema.parse(input);
  const t = await loadTemplate(ctx, d.id);
  const invoice = await createInvoice(ctx, invoiceInput(t, await templateLines(ctx, t.id), d.invoiceDate ?? today(), d.post ?? false), {
    recurringInvoiceId: t.id,
  });
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.recurring_invoice.used",
      entityType: "recurring_invoice",
      entityId: t.id,
      metadata: { name: t.name, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    },
    ctx.tx
  );
  return invoice;
}

// ---------------------------------------------------------------------------
// The daily run
// ---------------------------------------------------------------------------

export type RecurringInvoiceRunResult = {
  checked: number;
  created: number;
  posted: number;
  errors: Array<{ recurringInvoiceId: string; name: string; error: string }>;
};

/** Create (and for scheduled templates, post) every invoice due by `asOfDate`. One transaction per template. */
export async function runRecurringInvoicesForOrg(organizationId: string, asOfDate: string): Promise<RecurringInvoiceRunResult> {
  const due = await db
    .select({ id: recurringInvoices.id, name: recurringInvoices.name })
    .from(recurringInvoices)
    .where(
      and(
        eq(recurringInvoices.organizationId, organizationId),
        eq(recurringInvoices.status, "active"),
        inArray(recurringInvoices.type, ["scheduled", "reminder"]),
        isNotNull(recurringInvoices.nextRunDate),
        isNull(recurringInvoices.deletedAt),
        lte(sql`${recurringInvoices.nextRunDate} - ${recurringInvoices.daysInAdvance}`, sql`${asOfDate}::date`)
      )
    );
  const result: RecurringInvoiceRunResult = { checked: due.length, created: 0, posted: 0, errors: [] };
  const actor = systemActor(organizationId);
  for (const t of due) {
    try {
      const r = await runAs(actor, (ctx) => runTemplate(ctx, t.id, asOfDate));
      result.created += r.created;
      result.posted += r.posted;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push({ recurringInvoiceId: t.id, name: t.name, error: message });
      // A template deleted mid-run has nowhere to record it; the rest still run.
      await runAs(actor, (ctx) => recordFailure(ctx, t.id, message)).catch(() => undefined);
    }
  }
  return result;
}

async function runTemplate(ctx: Ctx, templateId: string, asOfDate: string): Promise<{ created: number; posted: number }> {
  let created = 0;
  let posted = 0;
  for (let i = 0; i < MAX_CATCH_UP; i++) {
    const t = await loadTemplate(ctx, templateId, true);
    if (t.status !== "active" || t.type === "unscheduled" || !t.nextRunDate) break;
    if (format(subDays(parseISO(t.nextRunDate), t.daysInAdvance), "yyyy-MM-dd") > asOfDate) break;

    const invoice = await createInvoice(ctx, invoiceInput(t, await templateLines(ctx, t.id), t.nextRunDate, false), { recurringInvoiceId: t.id });
    created++;
    let error: string | null = null;
    if (t.type === "scheduled") {
      try {
        // Savepoint: a refused post (closed period, say) keeps the draft for review.
        await ctx.tx.transaction((sp) => postInvoice({ actor: ctx.actor, tx: sp }, { id: invoice.id }));
        posted++;
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        error = `Created ${invoice.invoiceNumber} but couldn't post it: ${e.message}`;
      }
    }
    const occurrences = t.occurrences + 1;
    const next = nextScheduleDate(t.nextRunDate, t.frequency, t.startDate);
    const ended = hasEnded({ ...t, occurrences }, next);
    await ctx.tx
      .update(recurringInvoices)
      .set({
        occurrences,
        lastRunDate: t.nextRunDate,
        lastInvoiceId: invoice.id,
        lastError: error,
        nextRunDate: next,
        status: ended ? "ended" : "active",
        updatedAt: sql`now()`,
      })
      .where(eq(recurringInvoices.id, t.id));
    await writeAudit(
      {
        organizationId: ctx.actor.organizationId,
        ...auditFields(ctx.actor),
        event: "ar.recurring_invoice.ran",
        entityType: "recurring_invoice",
        entityId: t.id,
        metadata: {
          name: t.name,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: t.nextRunDate,
          posted: t.type === "scheduled" && !error,
          ...(error ? { error } : {}),
          ...(ended ? { ended: true } : {}),
        },
      },
      ctx.tx
    );
  }
  return { created, posted };
}

async function recordFailure(ctx: Ctx, templateId: string, message: string) {
  const t = await loadTemplate(ctx, templateId, true);
  await ctx.tx
    .update(recurringInvoices)
    .set({ lastError: message, updatedAt: sql`now()` })
    .where(eq(recurringInvoices.id, t.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.recurring_invoice.failed",
      entityType: "recurring_invoice",
      entityId: t.id,
      metadata: { name: t.name, nextRunDate: t.nextRunDate, error: message },
    },
    ctx.tx
  );
}
