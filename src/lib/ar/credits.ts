import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  arCreditApplications,
  arInvoices,
  arPayments,
  creditMemos,
  customers,
  organizations,
  refundReceipts,
  type ArCreditApplication,
  type ArInvoice,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, type Ctx, type Tx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { money, toDbMoney } from "@/lib/money";
import { id, positiveAmount } from "@/lib/schemas";
import { creditMemoLeftSql, invoiceSettled, paymentUnappliedSql } from "./balances";
import { recomputeInvoiceStatus } from "./posting";

/**
 * CUSTOMER CREDITS: a credit memo's unused amount, or a payment's
 * unapplied amount (an overpayment). They pay down open invoices (applied
 * automatically, oldest first, when the company's setting is on) or are
 * paid back with a credit refund. Applying moves nothing in the ledger.
 */

export type CustomerCredit = {
  kind: "credit_memo" | "payment";
  id: string;
  number: string;
  date: string;
  total: string;
  remaining: string;
};

/** Credits with something left, oldest first. Locks them when asked (anything that spends them). */
export async function openCredits(ctx: Ctx, customerId: string, lock = false): Promise<CustomerCredit[]> {
  const org = ctx.actor.organizationId;
  const memoQ = ctx.tx
    .select({
      id: creditMemos.id,
      number: creditMemos.memoNumber,
      date: creditMemos.memoDate,
      total: creditMemos.totalAmount,
      remaining: creditMemoLeftSql(sql`"credit_memos"."id"`, sql`"credit_memos"."total_amount"`),
    })
    .from(creditMemos)
    .where(and(eq(creditMemos.organizationId, org), eq(creditMemos.customerId, customerId), inArray(creditMemos.status, ["open", "applied"])));
  const payQ = ctx.tx
    .select({
      id: arPayments.id,
      number: arPayments.paymentNumber,
      date: arPayments.paymentDate,
      total: arPayments.amount,
      remaining: paymentUnappliedSql(sql`"ar_payments"."id"`, sql`"ar_payments"."amount"`),
    })
    .from(arPayments)
    .where(and(eq(arPayments.organizationId, org), eq(arPayments.customerId, customerId), eq(arPayments.status, "posted")));
  const [memos, payments] = lock ? await Promise.all([memoQ.for("update"), payQ.for("update")]) : await Promise.all([memoQ, payQ]);
  return [
    ...memos.map((m) => ({ kind: "credit_memo" as const, ...m })),
    ...payments.map((p) => ({ kind: "payment" as const, ...p })),
  ]
    .map((c) => ({ ...c, remaining: toDbMoney(c.remaining) }))
    .filter((c) => money(c.remaining).gt(0))
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

export const ListCustomerCreditsSchema = z.object({ customerId: id });

export async function listCustomerCredits(ctx: Ctx, input: z.input<typeof ListCustomerCreditsSchema>): Promise<CustomerCredit[]> {
  requirePermission(ctx.actor, "read", "viewer", "list customer credits");
  const { customerId } = ListCustomerCreditsSchema.parse(input);
  const [c] = await ctx.tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, ctx.actor.organizationId)));
  if (!c) throw notFound("Customer");
  return openCredits(ctx, customerId);
}

async function lockInvoice(ctx: Ctx, invoiceId: string): Promise<ArInvoice> {
  const [inv] = await ctx.tx
    .select()
    .from(arInvoices)
    .where(and(eq(arInvoices.id, invoiceId), eq(arInvoices.organizationId, ctx.actor.organizationId)))
    .for("update");
  if (!inv) throw notFound("Invoice");
  return inv;
}

const later = (a: string, b: string) => (a > b ? a : b);

async function insertApplication(
  ctx: Ctx,
  credit: CustomerCredit,
  target: { invoiceId: string } | { refundId: string },
  customerId: string,
  amount: string,
  appliedOn: string,
  automatic: boolean
): Promise<ArCreditApplication> {
  const [row] = await ctx.tx
    .insert(arCreditApplications)
    .values({
      organizationId: ctx.actor.organizationId,
      customerId,
      ...(credit.kind === "credit_memo" ? { creditMemoId: credit.id } : { paymentId: credit.id }),
      ...target,
      amount,
      appliedOn,
      automatic,
      ...creatorFields(ctx.actor),
    })
    .returning();
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.credit.applied",
      entityType: "ar_credit_application",
      entityId: row.id,
      metadata: { credit: credit.number, kind: credit.kind, ...target, amount, automatic },
    },
    ctx.tx
  );
  if (credit.kind === "credit_memo") await recomputeCreditMemoStatus(ctx.tx, ctx.actor.organizationId, credit.id);
  return row;
}

export async function recomputeCreditMemoStatus(tx: Tx, organizationId: string, memoId: string) {
  const [m] = await tx
    .select({ status: creditMemos.status, left: creditMemoLeftSql(sql`"credit_memos"."id"`, sql`"credit_memos"."total_amount"`) })
    .from(creditMemos)
    .where(and(eq(creditMemos.id, memoId), eq(creditMemos.organizationId, organizationId)));
  if (!m || (m.status !== "open" && m.status !== "applied")) return;
  const next = money(m.left).lte(0) ? "applied" : "open";
  if (next !== m.status) {
    await tx.update(creditMemos).set({ status: next, updatedAt: sql`now()` }).where(eq(creditMemos.id, memoId));
  }
}

// ---------------------------------------------------------------------------
// Apply / unapply by hand
// ---------------------------------------------------------------------------

export const ApplyCreditSchema = z
  .object({
    creditMemoId: id.optional().describe("The credit memo to use."),
    paymentId: id.optional().describe("Or a payment with an unapplied amount (an overpayment)."),
    invoiceId: id.describe("Open invoice of the same customer to pay down."),
    amount: positiveAmount.optional().describe("Default: as much as both sides allow."),
  })
  .refine((d) => Boolean(d.creditMemoId) !== Boolean(d.paymentId), { message: "Give creditMemoId or paymentId, not both." });

export async function applyCredit(ctx: Ctx, input: z.input<typeof ApplyCreditSchema>): Promise<ArCreditApplication> {
  requirePermission(ctx.actor, "write", "bookkeeper", "apply customer credits");
  const d = ApplyCreditSchema.parse(input);
  const invoice = await lockInvoice(ctx, d.invoiceId);
  if (invoice.status !== "open") throw invalidState(`Invoice ${invoice.invoiceNumber} is ${invoice.status}; credits apply to open invoices.`);
  const credit = (await openCredits(ctx, invoice.customerId, true)).find((c) => c.id === (d.creditMemoId ?? d.paymentId));
  if (!credit) throw new AppError("not_found", "That credit wasn't found for this invoice's customer, or nothing is left on it.");
  const open = money(invoice.totalAmount).minus(await invoiceSettled(ctx.tx, invoice.id));
  const max = money(credit.remaining).lt(open) ? money(credit.remaining) : open;
  const amount = d.amount ? money(d.amount) : max;
  if (amount.gt(max)) {
    throw new AppError("invalid_input", `At most ${max.toFixed(2)} can be applied (credit left ${money(credit.remaining).toFixed(2)}, invoice open ${open.toFixed(2)}).`);
  }
  if (amount.lte(0)) throw invalidState(`Invoice ${invoice.invoiceNumber} has nothing left to pay.`);
  const app = await insertApplication(ctx, credit, { invoiceId: invoice.id }, invoice.customerId, toDbMoney(amount), later(credit.date, invoice.invoiceDate), false);
  await recomputeInvoiceStatus(ctx.tx, ctx.actor.organizationId, invoice.id);
  return app;
}

export async function unapplyCredit(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "unapply customer credits");
  const { id: appId } = z.object({ id }).parse(input);
  const [app] = await ctx.tx
    .select()
    .from(arCreditApplications)
    .where(and(eq(arCreditApplications.id, appId), eq(arCreditApplications.organizationId, ctx.actor.organizationId)))
    .for("update");
  if (!app) throw notFound("Credit application");
  if (app.refundId) throw invalidState("This credit was paid out by a refund. Void the refund instead.");
  await removeApplications(ctx, [app], "unapplied");
  return { id: app.id };
}

// ---------------------------------------------------------------------------
// Automatic application
// ---------------------------------------------------------------------------

async function autoApplyOn(ctx: Ctx): Promise<boolean> {
  const [org] = await ctx.tx
    .select({ on: organizations.autoApplyCredits })
    .from(organizations)
    .where(eq(organizations.id, ctx.actor.organizationId));
  return org?.on ?? false;
}

/** A newly posted invoice takes the customer's credits, oldest first. */
export async function autoApplyCreditsToInvoice(ctx: Ctx, invoiceId: string) {
  if (!(await autoApplyOn(ctx))) return;
  const invoice = await lockInvoice(ctx, invoiceId);
  let open = money(invoice.totalAmount).minus(await invoiceSettled(ctx.tx, invoice.id));
  for (const credit of await openCredits(ctx, invoice.customerId, true)) {
    if (open.lte(0)) break;
    const take = money(credit.remaining).lt(open) ? money(credit.remaining) : open;
    await insertApplication(ctx, credit, { invoiceId: invoice.id }, invoice.customerId, toDbMoney(take), later(credit.date, invoice.invoiceDate), true);
    open = open.minus(take);
  }
  await recomputeInvoiceStatus(ctx.tx, ctx.actor.organizationId, invoice.id);
}

/** A newly posted credit memo pays down the customer's open invoices, oldest due first. */
export async function autoApplyCreditMemo(ctx: Ctx, memoId: string) {
  if (!(await autoApplyOn(ctx))) return;
  const [memo] = await ctx.tx.select().from(creditMemos).where(eq(creditMemos.id, memoId));
  const credit = (await openCredits(ctx, memo.customerId, true)).find((c) => c.id === memoId);
  if (!credit) return;
  let left = money(credit.remaining);
  const invoices = await ctx.tx
    .select()
    .from(arInvoices)
    .where(and(eq(arInvoices.organizationId, ctx.actor.organizationId), eq(arInvoices.customerId, memo.customerId), eq(arInvoices.status, "open")))
    .orderBy(asc(arInvoices.dueDate), asc(arInvoices.invoiceNumber))
    .for("update");
  for (const inv of invoices) {
    if (left.lte(0)) break;
    const open = money(inv.totalAmount).minus(await invoiceSettled(ctx.tx, inv.id));
    if (open.lte(0)) continue;
    const take = left.lt(open) ? left : open;
    await insertApplication(ctx, { ...credit, remaining: toDbMoney(left) }, { invoiceId: inv.id }, memo.customerId, toDbMoney(take), later(credit.date, inv.invoiceDate), true);
    await recomputeInvoiceStatus(ctx.tx, ctx.actor.organizationId, inv.id);
    left = left.minus(take);
  }
}

// ---------------------------------------------------------------------------
// Paying a credit out (credit refunds)
// ---------------------------------------------------------------------------

export const CreditUseSchema = z
  .object({
    creditMemoId: id.optional(),
    paymentId: id.optional(),
    amount: positiveAmount,
  })
  .refine((d) => Boolean(d.creditMemoId) !== Boolean(d.paymentId), { message: "Each credit names a creditMemoId or a paymentId." });
export type CreditUse = z.output<typeof CreditUseSchema>;

/** Which credits a refund of `total` uses: as given, or the oldest first. */
export async function planCreditUse(ctx: Ctx, customerId: string, total: string, uses: CreditUse[] | undefined): Promise<Array<{ credit: CustomerCredit; amount: string }>> {
  const credits = await openCredits(ctx, customerId, true);
  if (uses && uses.length > 0) {
    const sum = uses.reduce((s, u) => s.plus(money(u.amount)), money(0));
    if (!sum.eq(money(total))) throw new AppError("invalid_input", `The credits used (${sum.toFixed(2)}) must add up to the refund (${money(total).toFixed(2)}).`);
    return uses.map((u) => {
      const credit = credits.find((c) => c.id === (u.creditMemoId ?? u.paymentId));
      if (!credit) throw new AppError("not_found", "A credit wasn't found for this customer, or nothing is left on it.");
      if (money(u.amount).gt(money(credit.remaining))) {
        throw new AppError("invalid_input", `${credit.number} has only ${money(credit.remaining).toFixed(2)} left.`);
      }
      return { credit, amount: u.amount };
    });
  }
  let left = money(total);
  const plan: Array<{ credit: CustomerCredit; amount: string }> = [];
  for (const credit of credits) {
    if (left.lte(0)) break;
    const take = money(credit.remaining).lt(left) ? money(credit.remaining) : left;
    plan.push({ credit, amount: toDbMoney(take) });
    left = left.minus(take);
  }
  if (left.gt(0)) {
    const available = money(total).minus(left);
    throw new AppError("invalid_input", `This customer has only ${available.toFixed(2)} in credits to refund.`, { available: available.toFixed(2) });
  }
  return plan;
}

export async function applyCreditsToRefund(ctx: Ctx, refundId: string, customerId: string, refundDate: string, plan: Array<{ credit: CustomerCredit; amount: string }>) {
  for (const p of plan) {
    await insertApplication(ctx, p.credit, { refundId }, customerId, p.amount, later(p.credit.date, refundDate), false);
  }
}

// ---------------------------------------------------------------------------
// Voids
// ---------------------------------------------------------------------------

async function removeApplications(ctx: Ctx, apps: ArCreditApplication[], why: string) {
  if (apps.length === 0) return;
  await ctx.tx.delete(arCreditApplications).where(inArray(arCreditApplications.id, apps.map((a) => a.id)));
  for (const a of apps) {
    await writeAudit(
      {
        organizationId: ctx.actor.organizationId,
        ...auditFields(ctx.actor),
        event: "ar.credit.unapplied",
        entityType: "ar_credit_application",
        entityId: a.id,
        metadata: { creditMemoId: a.creditMemoId, paymentId: a.paymentId, invoiceId: a.invoiceId, refundId: a.refundId, amount: a.amount, why },
      },
      ctx.tx
    );
    if (a.invoiceId) await recomputeInvoiceStatus(ctx.tx, ctx.actor.organizationId, a.invoiceId);
    if (a.creditMemoId) await recomputeCreditMemoStatus(ctx.tx, ctx.actor.organizationId, a.creditMemoId);
  }
}

/**
 * Before voiding a credit memo, payment, or refund: take back its credit
 * applications. A credit already paid out by a refund blocks the void.
 */
export async function releaseCreditApplications(
  ctx: Ctx,
  of: { creditMemoId: string } | { paymentId: string } | { refundId: string },
  label: string
) {
  const where =
    "creditMemoId" in of
      ? eq(arCreditApplications.creditMemoId, of.creditMemoId)
      : "paymentId" in of
        ? eq(arCreditApplications.paymentId, of.paymentId)
        : eq(arCreditApplications.refundId, of.refundId);
  const apps = await ctx.tx
    .select()
    .from(arCreditApplications)
    .where(and(eq(arCreditApplications.organizationId, ctx.actor.organizationId), where))
    .for("update");
  if (!("refundId" in of) && apps.some((a) => a.refundId)) {
    const [r] = await ctx.tx
      .select({ number: refundReceipts.refundNumber })
      .from(refundReceipts)
      .where(eq(refundReceipts.id, apps.find((a) => a.refundId)!.refundId!));
    throw invalidState(`${label} was refunded on ${r?.number ?? "a refund"}. Void that refund first.`);
  }
  await removeApplications(ctx, apps, `${label} voided`);
}

/** Credits applied to an invoice, for its detail page. */
export async function creditsOnInvoice(ctx: Ctx, invoiceId: string) {
  return ctx.tx
    .select({
      id: arCreditApplications.id,
      amount: arCreditApplications.amount,
      appliedOn: arCreditApplications.appliedOn,
      automatic: arCreditApplications.automatic,
      creditMemoId: arCreditApplications.creditMemoId,
      paymentId: arCreditApplications.paymentId,
      creditNumber: sql<string>`COALESCE(${creditMemos.memoNumber}, ${arPayments.paymentNumber})`,
    })
    .from(arCreditApplications)
    .leftJoin(creditMemos, eq(creditMemos.id, arCreditApplications.creditMemoId))
    .leftJoin(arPayments, eq(arPayments.id, arCreditApplications.paymentId))
    .where(and(eq(arCreditApplications.organizationId, ctx.actor.organizationId), eq(arCreditApplications.invoiceId, invoiceId)))
    .orderBy(asc(arCreditApplications.appliedOn));
}

/** Where a credit memo's or payment's credit went. */
export async function usesOfCredit(ctx: Ctx, of: { creditMemoId: string } | { paymentId: string }) {
  return ctx.tx
    .select({
      id: arCreditApplications.id,
      amount: arCreditApplications.amount,
      appliedOn: arCreditApplications.appliedOn,
      automatic: arCreditApplications.automatic,
      invoiceId: arCreditApplications.invoiceId,
      refundId: arCreditApplications.refundId,
      targetNumber: sql<string>`COALESCE(${arInvoices.invoiceNumber}, ${refundReceipts.refundNumber})`,
    })
    .from(arCreditApplications)
    .leftJoin(arInvoices, eq(arInvoices.id, arCreditApplications.invoiceId))
    .leftJoin(refundReceipts, eq(refundReceipts.id, arCreditApplications.refundId))
    .where(
      and(
        eq(arCreditApplications.organizationId, ctx.actor.organizationId),
        "creditMemoId" in of ? eq(arCreditApplications.creditMemoId, of.creditMemoId) : eq(arCreditApplications.paymentId, of.paymentId)
      )
    )
    .orderBy(asc(arCreditApplications.appliedOn));
}
