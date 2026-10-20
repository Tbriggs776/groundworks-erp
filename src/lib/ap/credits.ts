import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  apBills,
  apCreditApplications,
  vendorCredits,
  vendorRefunds,
  vendors,
  type ApCreditApplication,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, type Ctx, type Tx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, invalidState, notFound } from "@/lib/errors";
import { money, toDbMoney } from "@/lib/money";
import { id, positiveAmount } from "@/lib/schemas";
import { billSettled, vendorCreditLeftSql } from "./balances";
import { recomputeBillPaymentStatus } from "./payments";

/**
 * Using vendor credits: against a vendor's posted bills (by hand), or paid
 * back by a vendor refund. An application never touches the ledger; the
 * credit and the bill both already sit in AP.
 */

export type VendorCreditBalance = { id: string; number: string; date: string; total: string; remaining: string };

/** The vendor's credits with something left, oldest first. */
export async function openVendorCredits(ctx: Ctx, vendorId: string, lock = false): Promise<VendorCreditBalance[]> {
  const q = ctx.tx
    .select({
      id: vendorCredits.id,
      number: vendorCredits.creditNumber,
      date: vendorCredits.creditDate,
      total: vendorCredits.totalAmount,
      remaining: sql<string>`${vendorCreditLeftSql(sql`"vendor_credits"."id"`, sql`"vendor_credits"."total_amount"`)}::text`,
    })
    .from(vendorCredits)
    .where(
      and(
        eq(vendorCredits.organizationId, ctx.actor.organizationId),
        eq(vendorCredits.vendorId, vendorId),
        inArray(vendorCredits.status, ["open", "applied"])
      )
    )
    .orderBy(asc(vendorCredits.creditDate), asc(vendorCredits.creditNumber));
  const rows = lock ? await q.for("update") : await q;
  return rows.filter((r) => money(r.remaining).gt(0));
}

export async function listVendorCreditsAvailable(ctx: Ctx, input: { vendorId: string }) {
  requirePermission(ctx.actor, "read", "viewer", "view vendor credits");
  const { vendorId } = z.object({ vendorId: id }).parse(input);
  return openVendorCredits(ctx, vendorId);
}

/** Every vendor's credits with something left, oldest first: what a refund can draw on. */
export async function allOpenVendorCredits(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "view vendor credits");
  const rows = await ctx.tx
    .select({
      id: vendorCredits.id,
      number: vendorCredits.creditNumber,
      date: vendorCredits.creditDate,
      currency: vendorCredits.currency,
      vendorId: vendors.id,
      vendorName: vendors.name,
      remaining: sql<string>`${vendorCreditLeftSql(sql`"vendor_credits"."id"`, sql`"vendor_credits"."total_amount"`)}::text`,
    })
    .from(vendorCredits)
    .innerJoin(vendors, eq(vendors.id, vendorCredits.vendorId))
    .where(and(eq(vendorCredits.organizationId, ctx.actor.organizationId), inArray(vendorCredits.status, ["open", "applied"])))
    .orderBy(asc(vendorCredits.creditDate), asc(vendorCredits.creditNumber));
  return rows.filter((r) => money(r.remaining).gt(0));
}

export async function recomputeVendorCreditStatus(tx: Tx, organizationId: string, creditId: string) {
  const [c] = await tx
    .select({
      status: vendorCredits.status,
      left: vendorCreditLeftSql(sql`"vendor_credits"."id"`, sql`"vendor_credits"."total_amount"`),
    })
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, creditId), eq(vendorCredits.organizationId, organizationId)));
  if (!c || (c.status !== "open" && c.status !== "applied")) return;
  const next = money(c.left).lte(0) ? "applied" : "open";
  if (next !== c.status) {
    await tx.update(vendorCredits).set({ status: next, updatedAt: sql`now()` }).where(eq(vendorCredits.id, creditId));
  }
}

const later = (a: string, b: string) => (a > b ? a : b);

async function insertApplication(
  ctx: Ctx,
  credit: VendorCreditBalance,
  target: { billId: string } | { vendorRefundId: string },
  vendorId: string,
  amount: string,
  appliedOn: string
): Promise<ApCreditApplication> {
  const [app] = await ctx.tx
    .insert(apCreditApplications)
    .values({
      organizationId: ctx.actor.organizationId,
      vendorId,
      vendorCreditId: credit.id,
      ...target,
      amount,
      appliedOn,
      ...creatorFields(ctx.actor),
    })
    .returning();
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "ap.credit.applied",
      entityType: "ap_credit_application",
      entityId: app.id,
      metadata: { vendorCreditId: credit.id, creditNumber: credit.number, ...target, amount },
    },
    ctx.tx
  );
  await recomputeVendorCreditStatus(ctx.tx, ctx.actor.organizationId, credit.id);
  return app;
}

export const ApplyVendorCreditSchema = z.object({
  vendorCreditId: id.describe("The vendor credit to use."),
  billId: id.describe("Posted bill of the same vendor to pay down."),
  amount: positiveAmount.optional().describe("Default: as much as both sides allow."),
});

export async function applyVendorCredit(ctx: Ctx, input: z.input<typeof ApplyVendorCreditSchema>): Promise<ApCreditApplication> {
  requirePermission(ctx.actor, "write", "bookkeeper", "apply vendor credits");
  const d = ApplyVendorCreditSchema.parse(input);
  const [bill] = await ctx.tx
    .select()
    .from(apBills)
    .where(and(eq(apBills.id, d.billId), eq(apBills.organizationId, ctx.actor.organizationId)))
    .for("update");
  if (!bill) throw notFound("Bill");
  if (bill.status !== "posted") throw invalidState(`Bill ${bill.billNumber} is ${bill.status}; credits apply to posted bills with a balance.`);
  const credit = (await openVendorCredits(ctx, bill.vendorId, true)).find((c) => c.id === d.vendorCreditId);
  if (!credit) throw new AppError("not_found", "That credit wasn't found for this bill's vendor, or nothing is left on it.");
  const open = money(bill.totalAmount).minus(await billSettled(ctx.tx, bill.id));
  const max = money(credit.remaining).lt(open) ? money(credit.remaining) : open;
  const amount = d.amount ? money(d.amount) : max;
  if (max.lte(0)) throw invalidState(`Bill ${bill.billNumber} has nothing left to pay.`);
  if (amount.gt(max)) {
    throw new AppError("invalid_input", `At most ${max.toFixed(2)} can be applied (credit left ${money(credit.remaining).toFixed(2)}, bill open ${open.toFixed(2)}).`);
  }
  const app = await insertApplication(ctx, credit, { billId: bill.id }, bill.vendorId, toDbMoney(amount), later(credit.date, bill.billDate));
  await recomputeBillPaymentStatus(ctx.tx, ctx.actor.organizationId, bill.id);
  return app;
}

async function removeApplications(ctx: Ctx, apps: ApCreditApplication[], why: string) {
  if (apps.length === 0) return;
  await ctx.tx.delete(apCreditApplications).where(inArray(apCreditApplications.id, apps.map((a) => a.id)));
  for (const a of apps) {
    await writeAudit(
      {
        organizationId: ctx.actor.organizationId,
        ...auditFields(ctx.actor),
        event: "ap.credit.unapplied",
        entityType: "ap_credit_application",
        entityId: a.id,
        metadata: { vendorCreditId: a.vendorCreditId, billId: a.billId, vendorRefundId: a.vendorRefundId, amount: a.amount, why },
      },
      ctx.tx
    );
    if (a.billId) await recomputeBillPaymentStatus(ctx.tx, ctx.actor.organizationId, a.billId);
    await recomputeVendorCreditStatus(ctx.tx, ctx.actor.organizationId, a.vendorCreditId);
  }
}

export async function unapplyVendorCredit(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "unapply vendor credits");
  const { id: appId } = z.object({ id }).parse(input);
  const [app] = await ctx.tx
    .select()
    .from(apCreditApplications)
    .where(and(eq(apCreditApplications.id, appId), eq(apCreditApplications.organizationId, ctx.actor.organizationId)))
    .for("update");
  if (!app) throw notFound("Credit application");
  if (app.vendorRefundId) throw invalidState("This credit came back as a vendor refund. Void the refund instead.");
  await removeApplications(ctx, [app], "unapplied");
  return { id: app.id };
}

/** The vendor's credits a refund draws on: the named one, or oldest first. */
export async function planVendorCreditUse(ctx: Ctx, vendorId: string, amount: string, vendorCreditId?: string | null) {
  const credits = await openVendorCredits(ctx, vendorId, true);
  const pool = vendorCreditId ? credits.filter((c) => c.id === vendorCreditId) : credits;
  if (vendorCreditId && pool.length === 0) throw new AppError("not_found", "That vendor credit wasn't found for this vendor, or nothing is left on it.");
  let need = money(amount);
  const plan: Array<{ credit: VendorCreditBalance; amount: string }> = [];
  for (const c of pool) {
    if (need.lte(0)) break;
    const take = money(c.remaining).lt(need) ? money(c.remaining) : need;
    plan.push({ credit: c, amount: toDbMoney(take) });
    need = need.minus(take);
  }
  if (need.gt(0)) {
    const have = money(amount).minus(need);
    throw new AppError("invalid_input", `The refund is ${money(amount).toFixed(2)} but only ${have.toFixed(2)} in vendor credit is available.`);
  }
  return plan;
}

export async function applyVendorCreditsToRefund(
  ctx: Ctx,
  refundId: string,
  vendorId: string,
  refundDate: string,
  plan: Array<{ credit: VendorCreditBalance; amount: string }>
) {
  for (const p of plan) {
    await insertApplication(ctx, p.credit, { vendorRefundId: refundId }, vendorId, p.amount, later(p.credit.date, refundDate));
  }
}

/**
 * Before voiding a vendor credit or refund: take back its applications. A
 * credit already paid back by a refund blocks voiding the credit.
 */
export async function releaseVendorCreditApplications(
  ctx: Ctx,
  of: { vendorCreditId: string } | { vendorRefundId: string },
  label: string
) {
  const where =
    "vendorCreditId" in of
      ? eq(apCreditApplications.vendorCreditId, of.vendorCreditId)
      : eq(apCreditApplications.vendorRefundId, of.vendorRefundId);
  const apps = await ctx.tx
    .select()
    .from(apCreditApplications)
    .where(and(eq(apCreditApplications.organizationId, ctx.actor.organizationId), where))
    .for("update");
  if ("vendorCreditId" in of && apps.some((a) => a.vendorRefundId)) {
    const [r] = await ctx.tx
      .select({ number: vendorRefunds.refundNumber })
      .from(vendorRefunds)
      .where(eq(vendorRefunds.id, apps.find((a) => a.vendorRefundId)!.vendorRefundId!));
    throw invalidState(`${label} came back on vendor refund ${r?.number ?? ""}. Void that refund first.`);
  }
  await removeApplications(ctx, apps, `${label} voided`);
}

/** Credits applied to a bill, for its page. */
export async function creditsOnBill(ctx: Ctx, billId: string) {
  return ctx.tx
    .select({
      applicationId: apCreditApplications.id,
      vendorCreditId: vendorCredits.id,
      creditNumber: vendorCredits.creditNumber,
      amount: apCreditApplications.amount,
      appliedOn: apCreditApplications.appliedOn,
    })
    .from(apCreditApplications)
    .innerJoin(vendorCredits, eq(vendorCredits.id, apCreditApplications.vendorCreditId))
    .where(and(eq(apCreditApplications.organizationId, ctx.actor.organizationId), eq(apCreditApplications.billId, billId)))
    .orderBy(asc(apCreditApplications.appliedOn));
}

/** Where a vendor credit went: bills it paid down and refunds that took it. */
export async function usesOfVendorCredit(ctx: Ctx, of: { vendorCreditId: string } | { vendorRefundId: string }) {
  return ctx.tx
    .select({
      applicationId: apCreditApplications.id,
      vendorCreditId: apCreditApplications.vendorCreditId,
      creditNumber: vendorCredits.creditNumber,
      billId: apCreditApplications.billId,
      billNumber: apBills.billNumber,
      vendorRefundId: apCreditApplications.vendorRefundId,
      refundNumber: vendorRefunds.refundNumber,
      amount: apCreditApplications.amount,
      appliedOn: apCreditApplications.appliedOn,
    })
    .from(apCreditApplications)
    .innerJoin(vendorCredits, eq(vendorCredits.id, apCreditApplications.vendorCreditId))
    .leftJoin(apBills, eq(apBills.id, apCreditApplications.billId))
    .leftJoin(vendorRefunds, eq(vendorRefunds.id, apCreditApplications.vendorRefundId))
    .where(
      and(
        eq(apCreditApplications.organizationId, ctx.actor.organizationId),
        "vendorCreditId" in of
          ? eq(apCreditApplications.vendorCreditId, of.vendorCreditId)
          : eq(apCreditApplications.vendorRefundId, of.vendorRefundId)
      )
    )
    .orderBy(asc(apCreditApplications.appliedOn));
}
