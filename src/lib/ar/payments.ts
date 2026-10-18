import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  arInvoices,
  arPaymentApplications,
  arPayments,
  customers,
  paymentMethod,
  type ArPayment,
  type ArPaymentApplication,
} from "@/lib/db/schema";
import {
  auditFields,
  creatorFields,
  requirePermission,
  requirePostingWithinLimit,
  type Ctx,
} from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { requirePostingAccount } from "@/lib/gl/lookups";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { requireActiveCustomer } from "@/lib/parties/service";
import {
  amount,
  currency,
  id,
  isoDate,
  nonNegativeAmount,
  optionalText,
  pagination,
  positiveAmount,
  toPage,
  type Page,
} from "@/lib/schemas";
import {
  invoiceAppliedTotal,
  postCustomerPaymentToGl,
  recomputeInvoiceStatus,
  voidCustomerPaymentFromGl,
} from "./posting";

/**
 * CUSTOMER PAYMENTS (receive payment). Money in against open invoices.
 * Either list the applications explicitly, or give a total `amount` and
 * let it apply oldest-due-first across the customer's open invoices.
 */

const ApplicationSchema = z.object({
  invoiceId: id,
  amount: positiveAmount.describe("Cash applied to this invoice."),
  discountAmount: nonNegativeAmount
    .optional()
    .describe("Early-pay discount given, on top of `amount`. Balance drops by amount + discount."),
});

export const CreateCustomerPaymentSchema = z
  .object({
    customerId: id,
    paymentDate: isoDate,
    method: z.enum(paymentMethod.enumValues),
    reference: optionalText(100).describe("Check #, transaction id, or confirmation."),
    depositAccountId: id
      .optional()
      .describe("Bank / cash account the money lands in. Defaults to 1250 Undeposited Funds."),
    currency: currency.optional(),
    exchangeRate: amount.optional(),
    memo: optionalText(500),
    applications: z
      .array(ApplicationSchema)
      .min(1)
      .optional()
      .describe("Which invoices this pays. Omit and pass `amount` to auto-apply oldest first."),
    amount: positiveAmount
      .optional()
      .describe("Total received. Used to auto-apply when `applications` is omitted."),
    post: z.boolean().optional().describe("Post to the ledger in the same call."),
  })
  .refine((d) => d.applications || d.amount, {
    message: "Provide applications, or an amount to auto-apply.",
  });
export type CreateCustomerPaymentInput = z.input<typeof CreateCustomerPaymentSchema>;

export const ListCustomerPaymentsSchema = z.object({
  status: z.enum(["draft", "posted", "voided"]).optional(),
  customerId: id.optional(),
  ...pagination,
});

const IdSchema = z.object({ id });
const VoidSchema = z.object({ id, reason: z.string().trim().min(1).max(500) });

export type CustomerPaymentRow = ArPayment & { customerName: string };
export type CustomerPaymentDetail = CustomerPaymentRow & {
  applications: Array<ArPaymentApplication & { invoiceNumber: string }>;
};

export async function listCustomerPayments(
  ctx: Ctx,
  input: z.input<typeof ListCustomerPaymentsSchema>
): Promise<Page<CustomerPaymentRow>> {
  requirePermission(ctx.actor, "read", "viewer", "list customer payments");
  const f = ListCustomerPaymentsSchema.parse(input);
  const rows = await ctx.tx
    .select({ payment: arPayments, customerName: customers.name })
    .from(arPayments)
    .innerJoin(customers, eq(customers.id, arPayments.customerId))
    .where(
      and(
        eq(arPayments.organizationId, ctx.actor.organizationId),
        isNull(arPayments.deletedAt),
        f.status ? eq(arPayments.status, f.status) : undefined,
        f.customerId ? eq(arPayments.customerId, f.customerId) : undefined
      )
    )
    .orderBy(desc(arPayments.paymentDate), desc(arPayments.paymentNumber))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(
    rows.map((r) => ({ ...r.payment, customerName: r.customerName })),
    f.limit,
    f.offset
  );
}

export async function getCustomerPayment(
  ctx: Ctx,
  input: { id: string }
): Promise<CustomerPaymentDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view customer payments");
  const { id: paymentId } = IdSchema.parse(input);
  const [row] = await ctx.tx
    .select({ payment: arPayments, customerName: customers.name })
    .from(arPayments)
    .innerJoin(customers, eq(customers.id, arPayments.customerId))
    .where(
      and(eq(arPayments.id, paymentId), eq(arPayments.organizationId, ctx.actor.organizationId))
    );
  if (!row) throw notFound("Customer payment");
  const apps = await ctx.tx
    .select({ app: arPaymentApplications, invoiceNumber: arInvoices.invoiceNumber })
    .from(arPaymentApplications)
    .innerJoin(arInvoices, eq(arInvoices.id, arPaymentApplications.invoiceId))
    .where(eq(arPaymentApplications.paymentId, paymentId))
    .orderBy(asc(arInvoices.invoiceNumber));
  return {
    ...row.payment,
    customerName: row.customerName,
    applications: apps.map((a) => ({ ...a.app, invoiceNumber: a.invoiceNumber })),
  };
}

async function loadPayment(ctx: Ctx, paymentId: string): Promise<ArPayment> {
  const [p] = await ctx.tx
    .select()
    .from(arPayments)
    .where(
      and(eq(arPayments.id, paymentId), eq(arPayments.organizationId, ctx.actor.organizationId))
    )
    .for("update");
  if (!p) throw notFound("Customer payment");
  return p;
}

type App = { invoiceId: string; amount: string; discountAmount: string };

/** Spread `total` across the customer's open invoices, oldest due first. */
async function autoApply(ctx: Ctx, customerId: string, total: string): Promise<App[]> {
  const open = await ctx.tx
    .select()
    .from(arInvoices)
    .where(
      and(
        eq(arInvoices.organizationId, ctx.actor.organizationId),
        eq(arInvoices.customerId, customerId),
        eq(arInvoices.status, "open")
      )
    )
    .orderBy(asc(arInvoices.dueDate), asc(arInvoices.invoiceNumber));
  let remaining = money(total);
  const apps: App[] = [];
  for (const inv of open) {
    if (remaining.lte(0)) break;
    const balance = money(inv.totalAmount).minus(await invoiceAppliedTotal(ctx.tx, inv.id));
    if (balance.lte(0)) continue;
    const take = remaining.lt(balance) ? remaining : balance;
    apps.push({ invoiceId: inv.id, amount: toDbMoney(take), discountAmount: "0.0000" });
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) {
    const openTotal = money(total).minus(remaining);
    throw new AppError(
      "invalid_input",
      `Payment of ${money(total).toFixed(2)} exceeds this customer's open invoices (${openTotal.toFixed(2)}). Unapplied credits aren't supported yet; record the excess separately.`,
      { openBalance: openTotal.toFixed(2) }
    );
  }
  return apps;
}

/** Each application targets an open invoice of this customer and fits its balance. */
async function assertApplicationsFit(ctx: Ctx, customerId: string, apps: App[]) {
  const ids = apps.map((a) => a.invoiceId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError("invalid_input", "Each invoice may appear only once in a payment.");
  }
  const invs = await ctx.tx
    .select()
    .from(arInvoices)
    .where(and(eq(arInvoices.organizationId, ctx.actor.organizationId), inArray(arInvoices.id, ids)))
    .for("update");
  if (invs.length !== ids.length) throw notFound("One or more invoices");
  for (const a of apps) {
    const inv = invs.find((i) => i.id === a.invoiceId)!;
    if (inv.customerId !== customerId) {
      throw new AppError("invalid_input", `Invoice ${inv.invoiceNumber} belongs to a different customer.`);
    }
    if (inv.status !== "open") {
      throw invalidState(`Invoice ${inv.invoiceNumber} is ${inv.status}; only open invoices can be paid.`);
    }
    const balance = money(inv.totalAmount).minus(await invoiceAppliedTotal(ctx.tx, inv.id));
    const reduction = money(a.amount).plus(money(a.discountAmount));
    if (reduction.gt(balance)) {
      throw new AppError(
        "invalid_input",
        `Invoice ${inv.invoiceNumber} has only ${balance.toFixed(2)} open; tried to apply ${reduction.toFixed(2)}.`,
        { invoiceId: inv.id, openBalance: balance.toFixed(2) }
      );
    }
  }
}

/** Default deposit account: 1250 Undeposited Funds, if the org has it. */
async function defaultDepositAccount(ctx: Ctx): Promise<string> {
  const [row] = await ctx.tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, ctx.actor.organizationId),
        eq(accounts.code, "1250"),
        eq(accounts.isCash, true)
      )
    );
  if (!row) {
    throw new AppError(
      "invalid_input",
      "depositAccountId is required (this org has no 1250 Undeposited Funds account to default to)."
    );
  }
  return row.id;
}

export async function createCustomerPayment(
  ctx: Ctx,
  input: CreateCustomerPaymentInput
): Promise<CustomerPaymentDetail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record customer payments");
  const d = CreateCustomerPaymentSchema.parse(input);
  const org = ctx.actor.organizationId;
  const customer = await requireActiveCustomer(ctx, d.customerId);
  const depositAccountId = d.depositAccountId ?? (await defaultDepositAccount(ctx));
  await requirePostingAccount(ctx.tx, org, depositAccountId, {
    cash: true,
    label: "Deposit account",
  });

  const apps: App[] = d.applications
    ? d.applications.map((a) => ({
        invoiceId: a.invoiceId,
        amount: a.amount,
        discountAmount: a.discountAmount ?? "0.0000",
      }))
    : await autoApply(ctx, customer.id, d.amount!);
  if (apps.length === 0) {
    throw new AppError("invalid_input", "This customer has no open invoices to apply a payment to.");
  }
  await assertApplicationsFit(ctx, customer.id, apps);

  const cash = sumMoney(apps.map((a) => a.amount));
  if (d.applications && d.amount && !money(d.amount).eq(cash)) {
    throw new AppError(
      "invalid_input",
      `amount (${money(d.amount).toFixed(2)}) doesn't match the applications (${cash.toFixed(2)}).`
    );
  }
  const discount = sumMoney(apps.map((a) => a.discountAmount));
  const paymentNumber = await nextNumber(ctx.tx, org, "ARPAY");

  const [payment] = await ctx.tx
    .insert(arPayments)
    .values({
      organizationId: org,
      paymentNumber,
      customerId: customer.id,
      paymentDate: d.paymentDate,
      method: d.method,
      reference: d.reference,
      depositAccountId,
      currency: d.currency ?? customer.currency,
      exchangeRate: d.exchangeRate ?? "1",
      amount: toDbMoney(cash),
      discountAmount: toDbMoney(discount),
      memo: d.memo,
      status: "draft",
      ...creatorFields(ctx.actor),
    })
    .returning();
  await ctx.tx.insert(arPaymentApplications).values(
    apps.map((a) => ({
      organizationId: org,
      paymentId: payment.id,
      invoiceId: a.invoiceId,
      amount: a.amount,
      discountAmount: a.discountAmount,
    }))
  );

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "ar.payment.created",
      entityType: "ar_payment",
      entityId: payment.id,
      metadata: {
        paymentNumber,
        customerId: customer.id,
        amount: toDbMoney(cash),
        discount: toDbMoney(discount),
        invoiceCount: apps.length,
        autoApplied: !d.applications,
      },
    },
    ctx.tx
  );

  if (d.post) return postCustomerPayment(ctx, { id: payment.id });
  return getCustomerPayment(ctx, { id: payment.id });
}

export async function postCustomerPayment(
  ctx: Ctx,
  input: { id: string }
): Promise<CustomerPaymentDetail> {
  requirePermission(ctx.actor, "post", "bookkeeper", "post customer payments");
  const { id: paymentId } = IdSchema.parse(input);
  const payment = await loadPayment(ctx, paymentId);
  if (payment.status !== "draft") {
    throw invalidState(`Only draft payments can be posted (this one is ${payment.status}).`);
  }
  requirePostingWithinLimit(
    ctx.actor,
    money(payment.amount).times(money(payment.exchangeRate)),
    `Customer payment ${payment.paymentNumber}`
  );
  const apps = await ctx.tx
    .select()
    .from(arPaymentApplications)
    .where(eq(arPaymentApplications.paymentId, paymentId));
  await assertApplicationsFit(
    ctx,
    payment.customerId,
    apps.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount, discountAmount: a.discountAmount }))
  );

  const { journalId } = await postCustomerPaymentToGl(ctx, payment);
  await ctx.tx
    .update(arPayments)
    .set({
      status: "posted",
      postedAt: sql`now()`,
      postedBy: ctx.actor.userId,
      glJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(arPayments.id, paymentId));
  for (const a of apps) {
    await recomputeInvoiceStatus(ctx.tx, ctx.actor.organizationId, a.invoiceId);
  }
  return getCustomerPayment(ctx, { id: paymentId });
}

export async function voidCustomerPayment(
  ctx: Ctx,
  input: z.input<typeof VoidSchema>
): Promise<CustomerPaymentDetail> {
  requirePermission(ctx.actor, "post", "admin", "void customer payments");
  const { id: paymentId, reason } = VoidSchema.parse(input);
  const payment = await loadPayment(ctx, paymentId);
  if (payment.status !== "posted") {
    throw invalidState(`Only posted payments can be voided (this one is ${payment.status}).`);
  }
  const { journalId } = await voidCustomerPaymentFromGl(ctx, payment, reason);
  await ctx.tx
    .update(arPayments)
    .set({
      status: "voided",
      voidedAt: sql`now()`,
      voidedBy: ctx.actor.userId,
      voidReason: reason,
      voidGlJournalId: journalId,
      updatedAt: sql`now()`,
    })
    .where(eq(arPayments.id, paymentId));
  const apps = await ctx.tx
    .select({ invoiceId: arPaymentApplications.invoiceId })
    .from(arPaymentApplications)
    .where(eq(arPaymentApplications.paymentId, paymentId));
  for (const a of apps) {
    await recomputeInvoiceStatus(ctx.tx, ctx.actor.organizationId, a.invoiceId);
  }
  return getCustomerPayment(ctx, { id: paymentId });
}

export async function deleteDraftCustomerPayment(
  ctx: Ctx,
  input: { id: string }
): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete draft customer payments");
  const { id: paymentId } = IdSchema.parse(input);
  const payment = await loadPayment(ctx, paymentId);
  if (payment.status !== "draft") {
    throw invalidState(`Only drafts can be deleted (this one is ${payment.status}). Void it instead.`);
  }
  await ctx.tx.delete(arPayments).where(eq(arPayments.id, paymentId));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ar.payment.deleted",
      entityType: "ar_payment",
      entityId: paymentId,
      metadata: { paymentNumber: payment.paymentNumber },
    },
    ctx.tx
  );
  return { id: paymentId };
}
