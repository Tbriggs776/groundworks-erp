"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  apBills,
  apPaymentApplications,
  apPayments,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import {
  postPaymentToGl,
  recomputeBillPaymentStatus,
  voidPaymentFromGl,
} from "@/lib/ap/payments";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";

/**
 * AP Payments: create → post → (optionally) void. No approval gate in v1;
 * add one via approvalThresholds + scope='ap_payment' later if needed.
 */

const ApplicationSchema = z
  .object({
    billId: z.string().uuid(),
    appliedAmount: z.string().trim(),
    discountAmount: z.string().trim().default("0"),
  })
  .refine((a) => money(a.appliedAmount).gt(0), {
    message: "Applied amount must be > 0.",
    path: ["appliedAmount"],
  });

const PaymentSchema = z.object({
  vendorId: z.string().uuid(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(["check", "ach", "wire", "credit_card", "cash", "other"]),
  reference: z.string().optional().or(z.literal("")),
  bankAccountId: z.string().uuid(),
  currency: z.string().length(3).default("USD"),
  exchangeRate: z.string().default("1"),
  memo: z.string().optional().or(z.literal("")),
  applications: z
    .array(ApplicationSchema)
    .min(1, "A payment must apply to at least one bill."),
});

export type PaymentInput = z.input<typeof PaymentSchema>;
export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function createPayment(
  input: PaymentInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = PaymentSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  // Validate all bills belong to the same vendor + org + are posted and
  // open-balance >= applied_amount.
  const billIds = parsed.data.applications.map((a) => a.billId);
  const bills = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.organizationId, organizationId), inArray(apBills.id, billIds))
    );
  if (bills.length !== billIds.length) {
    return { ok: false, error: "One or more bills not found in this org." };
  }
  for (const b of bills) {
    if (b.vendorId !== parsed.data.vendorId) {
      return {
        ok: false,
        error: `Bill ${b.billNumber} belongs to a different vendor.`,
      };
    }
    if (b.status !== "posted" && b.status !== "paid") {
      return {
        ok: false,
        error: `Bill ${b.billNumber} is ${b.status} — only posted/paid bills can receive payments.`,
      };
    }
  }

  // Compute applied/discount/net totals
  const applied = sumMoney(
    parsed.data.applications.flatMap((a) => [a.appliedAmount, a.discountAmount || "0"])
  );
  const discount = sumMoney(
    parsed.data.applications.map((a) => a.discountAmount || "0")
  );
  const net = applied.minus(discount);

  // Per-bill guard: applied+discount must not exceed bill.openBalance
  // (open = totalAmount − sum(posted applications))
  const existing = await db
    .select({
      billId: apPaymentApplications.billId,
      applied: apPaymentApplications.appliedAmount,
      discount: apPaymentApplications.discountAmount,
    })
    .from(apPaymentApplications)
    .innerJoin(apPayments, eq(apPayments.id, apPaymentApplications.paymentId))
    .where(
      and(
        eq(apPayments.status, "posted"),
        inArray(apPaymentApplications.billId, billIds)
      )
    );
  const priorByBill = new Map<string, string>();
  for (const e of existing) {
    const cur = priorByBill.get(e.billId) ?? "0";
    priorByBill.set(
      e.billId,
      money(cur).plus(money(e.applied)).plus(money(e.discount)).toFixed(4)
    );
  }
  for (const a of parsed.data.applications) {
    const bill = bills.find((b) => b.id === a.billId)!;
    const prior = money(priorByBill.get(a.billId) ?? "0");
    const thisApp = money(a.appliedAmount).plus(money(a.discountAmount || "0"));
    const total = money(bill.totalAmount);
    if (prior.plus(thisApp).gt(total)) {
      const remaining = total.minus(prior);
      return {
        ok: false,
        error: `Bill ${bill.billNumber} has only ${remaining.toFixed(
          2
        )} open; you tried to apply ${thisApp.toFixed(2)}.`,
      };
    }
  }

  try {
    const id = await db.transaction(async (tx) => {
      const paymentNumber = await nextNumber(tx, organizationId, "APPAY");
      const [payment] = await tx
        .insert(apPayments)
        .values({
          organizationId,
          paymentNumber,
          vendorId: parsed.data.vendorId,
          paymentDate: parsed.data.paymentDate,
          method: parsed.data.method,
          reference: parsed.data.reference || null,
          bankAccountId: parsed.data.bankAccountId,
          currency: parsed.data.currency.toUpperCase(),
          exchangeRate: parsed.data.exchangeRate,
          appliedAmount: toDbMoney(applied),
          discountAmount: toDbMoney(discount),
          netAmount: toDbMoney(net),
          memo: parsed.data.memo || null,
          status: "draft",
        })
        .returning({ id: apPayments.id });

      await tx.insert(apPaymentApplications).values(
        parsed.data.applications.map((a) => ({
          organizationId,
          paymentId: payment.id,
          billId: a.billId,
          appliedAmount: toDbMoney(a.appliedAmount),
          discountAmount: toDbMoney(a.discountAmount || "0"),
        }))
      );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "ap.payment.created",
          entityType: "ap_payment",
          entityId: payment.id,
          metadata: {
            paymentNumber,
            vendorId: parsed.data.vendorId,
            applied: toDbMoney(applied),
            discount: toDbMoney(discount),
            billCount: parsed.data.applications.length,
          },
        },
        tx
      );

      return payment.id;
    });

    revalidatePath("/ap/payments");
    return { ok: true, id };
  } catch (err) {
    console.error("[ap] createPayment failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function postPayment(paymentId: string): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const [payment] = await db
    .select()
    .from(apPayments)
    .where(
      and(
        eq(apPayments.id, paymentId),
        eq(apPayments.organizationId, organizationId)
      )
    );
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.status !== "draft") {
    return {
      ok: false,
      error: `Only draft payments can be posted (this one is ${payment.status}).`,
    };
  }

  try {
    await db.transaction(async (tx) => {
      const result = await postPaymentToGl(tx, {
        payment,
        actorId: actor?.id ?? null,
        organizationId,
      });

      await tx
        .update(apPayments)
        .set({
          status: "posted",
          postedAt: sql`now()`,
          postedBy: actor?.id ?? null,
          glJournalId: result.journalId,
          updatedAt: sql`now()`,
        })
        .where(eq(apPayments.id, paymentId));

      // Recompute paid status on every affected bill
      const apps = await tx
        .select({ billId: apPaymentApplications.billId })
        .from(apPaymentApplications)
        .where(eq(apPaymentApplications.paymentId, paymentId));
      for (const a of apps) {
        await recomputeBillPaymentStatus(tx, organizationId, a.billId);
      }
    });

    revalidatePath("/ap/payments");
    revalidatePath(`/ap/payments/${paymentId}`);
    revalidatePath("/ap/bills");
    revalidatePath("/gl");
    return { ok: true, id: paymentId };
  } catch (err) {
    console.error("[ap] postPayment failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function voidPayment(
  paymentId: string,
  reason: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  if (!reason.trim()) {
    return { ok: false, error: "Void reason is required." };
  }

  const [payment] = await db
    .select()
    .from(apPayments)
    .where(
      and(
        eq(apPayments.id, paymentId),
        eq(apPayments.organizationId, organizationId)
      )
    );
  if (!payment) return { ok: false, error: "Payment not found." };
  if (payment.status !== "posted") {
    return {
      ok: false,
      error: `Only posted payments can be voided (this one is ${payment.status}).`,
    };
  }

  try {
    await db.transaction(async (tx) => {
      const { journalId } = await voidPaymentFromGl(tx, {
        payment,
        actorId: actor?.id ?? null,
        organizationId,
        reason: reason.trim(),
      });

      await tx
        .update(apPayments)
        .set({
          status: "voided",
          voidedAt: sql`now()`,
          voidedBy: actor?.id ?? null,
          voidReason: reason.trim(),
          voidGlJournalId: journalId,
          updatedAt: sql`now()`,
        })
        .where(eq(apPayments.id, paymentId));

      // Recompute paid status — a voided payment no longer counts, so
      // bills may drop from 'paid' back to 'posted'.
      const apps = await tx
        .select({ billId: apPaymentApplications.billId })
        .from(apPaymentApplications)
        .where(eq(apPaymentApplications.paymentId, paymentId));
      for (const a of apps) {
        await recomputeBillPaymentStatus(tx, organizationId, a.billId);
      }
    });

    revalidatePath("/ap/payments");
    revalidatePath(`/ap/payments/${paymentId}`);
    revalidatePath("/ap/bills");
    revalidatePath("/gl");
    return { ok: true, id: paymentId };
  } catch (err) {
    console.error("[ap] voidPayment failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
