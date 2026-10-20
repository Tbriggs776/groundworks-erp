import type Decimal from "decimal.js";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { arInvoiceLines, arInvoices, estimateLines, estimates, type Estimate, type EstimateLine } from "@/lib/db/schema";
import { auditFields, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { money } from "@/lib/money";

/**
 * Progress invoicing: how much of each estimate line has been billed.
 *
 * An invoice line bills an estimate line when it points at it
 * (`ar_invoice_lines.estimate_line_id`). Billed = Σ those invoice lines on
 * invoices that aren't voided (drafts count: they hold their share until
 * deleted). Remaining = estimate line amount − billed. Signs follow the
 * estimate line, so a discount line bills down toward zero from below.
 */

export async function loadEstimate(ctx: Ctx, estimateId: string, lock = false): Promise<Estimate> {
  const q = ctx.tx
    .select()
    .from(estimates)
    .where(and(eq(estimates.id, estimateId), eq(estimates.organizationId, ctx.actor.organizationId), isNull(estimates.deletedAt)));
  const [e] = lock ? await q.for("update") : await q;
  if (!e) throw notFound("Estimate");
  return e;
}

export async function linesOfEstimate(ctx: Ctx, estimateId: string): Promise<EstimateLine[]> {
  return ctx.tx.select().from(estimateLines).where(eq(estimateLines.estimateId, estimateId)).orderBy(asc(estimateLines.lineNumber));
}

/** Billed so far per estimate line, optionally leaving one invoice out (the one being edited). */
export async function billedByLine(ctx: Ctx, estimateId: string, excludeInvoiceId?: string): Promise<Map<string, Decimal>> {
  const rows = await ctx.tx
    .select({ lineId: arInvoiceLines.estimateLineId, billed: sql<string>`SUM(${arInvoiceLines.amount})::text` })
    .from(arInvoiceLines)
    .innerJoin(arInvoices, eq(arInvoices.id, arInvoiceLines.invoiceId))
    .where(
      and(
        eq(arInvoices.organizationId, ctx.actor.organizationId),
        eq(arInvoices.estimateId, estimateId),
        ne(arInvoices.status, "voided"),
        isNull(arInvoices.deletedAt),
        excludeInvoiceId ? ne(arInvoices.id, excludeInvoiceId) : undefined
      )
    )
    .groupBy(arInvoiceLines.estimateLineId);
  return new Map(rows.filter((r) => r.lineId).map((r) => [r.lineId as string, money(r.billed)]));
}

/** Invoices that bill this estimate and aren't voided. */
export async function liveInvoiceCount(ctx: Ctx, estimateId: string): Promise<number> {
  const [r] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(arInvoices)
    .where(
      and(
        eq(arInvoices.organizationId, ctx.actor.organizationId),
        eq(arInvoices.estimateId, estimateId),
        ne(arInvoices.status, "voided"),
        isNull(arInvoices.deletedAt)
      )
    );
  return r?.n ?? 0;
}

export function remainingOf(line: Pick<EstimateLine, "amount">, billed: Decimal | undefined): Decimal {
  return money(line.amount).minus(billed ?? 0);
}

/**
 * Check an invoice's estimate links before it's saved: the lines must
 * belong to the invoice's estimate, keep the estimate line's sign, and
 * stay within what's left to bill. Returns the estimate (locked) or null.
 */
export async function checkEstimateBilling(
  ctx: Ctx,
  opts: {
    estimateId: string | null;
    customerId: string;
    invoiceId?: string;
    lines: Array<{ estimateLineId?: string | null; amount: string; description: string | null }>;
  }
): Promise<Estimate | null> {
  const linked = opts.lines.map((l, i) => ({ ...l, n: i + 1 })).filter((l) => l.estimateLineId);
  if (!opts.estimateId) {
    if (linked.length > 0) {
      throw new AppError(
        "invalid_input",
        "Lines can point at an estimate only on an invoice made from it. Use create_invoice_from_estimate."
      );
    }
    return null;
  }
  const est = await loadEstimate(ctx, opts.estimateId, true);
  if (est.customerId !== opts.customerId) {
    throw new AppError("invalid_input", `This invoice bills estimate ${est.estimateNumber}; its customer can't change.`);
  }
  const estLines = new Map((await linesOfEstimate(ctx, est.id)).map((l) => [l.id, l]));
  const billed = await billedByLine(ctx, est.id, opts.invoiceId);
  const adding = new Map<string, Decimal>();
  for (const l of linked) {
    const el = estLines.get(l.estimateLineId!);
    if (!el) throw new AppError("invalid_input", `Line ${l.n}: that estimate line isn't on ${est.estimateNumber}.`);
    const amt = money(l.amount);
    const estAmt = money(el.amount);
    if (!amt.isZero() && amt.isNegative() !== estAmt.isNegative()) {
      throw new AppError("invalid_input", `Line ${l.n}: bills ${amt.toFixed(2)} against an estimate line of ${estAmt.toFixed(2)}; the signs must match.`);
    }
    adding.set(el.id, (adding.get(el.id) ?? money(0)).plus(amt));
  }
  for (const [lineId, amt] of adding) {
    const el = estLines.get(lineId)!;
    const left = remainingOf(el, billed.get(lineId));
    if (money(el.amount).isNegative() ? amt.lt(left) : amt.gt(left)) {
      throw new AppError(
        "invalid_input",
        `Estimate line ${el.lineNumber} (${el.description ?? "no description"}): this invoice bills ${amt.toFixed(2)} but only ${left.toFixed(2)} is left on ${est.estimateNumber}.`
      );
    }
  }
  return est;
}

/**
 * Close an estimate once every line is fully billed. With `reopen` (after an
 * invoice from it is voided or deleted), a closed estimate with something
 * left to bill opens again.
 */
export async function syncEstimateStatus(ctx: Ctx, estimateId: string, opts: { reopen?: boolean } = {}) {
  const est = await loadEstimate(ctx, estimateId, true);
  const lines = await linesOfEstimate(ctx, est.id);
  const billed = await billedByLine(ctx, est.id);
  const fullyBilled = lines.length > 0 && lines.every((l) => remainingOf(l, billed.get(l.id)).isZero());
  let next: Estimate["status"] | null = null;
  if (fullyBilled && (est.status === "pending" || est.status === "accepted")) next = "closed";
  if (!fullyBilled && opts.reopen && est.status === "closed") next = est.acceptedDate ? "accepted" : "pending";
  if (!next) return;
  await ctx.tx.update(estimates).set({ status: next, updatedAt: sql`now()` }).where(eq(estimates.id, est.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: next === "closed" ? "ar.estimate.closed" : "ar.estimate.reopened",
      entityType: "estimate",
      entityId: est.id,
      metadata: { estimateNumber: est.estimateNumber, automatic: true },
    },
    ctx.tx
  );
}

/** Estimates are billed only while pending or accepted. */
export function requireBillable(est: Estimate) {
  if (est.status !== "pending" && est.status !== "accepted") {
    throw invalidState(`Estimate ${est.estimateNumber} is ${est.status}. Reopen it to bill more.`);
  }
}
