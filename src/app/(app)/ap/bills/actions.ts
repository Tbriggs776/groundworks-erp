"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { apBillLines, apBills } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireCurrentOrg, requireRole } from "@/lib/auth";
import {
  canApproveAtRole,
  resolveApprovalRouting,
} from "@/lib/ap/approval";
import { postBillToGl, voidBillFromGl } from "@/lib/ap/posting";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";

/**
 * AP Bill lifecycle actions. State machine enforced in every mutator:
 *   draft → pending_approval → approved | rejected → posted → voided | paid
 * Rejected bills drop back to draft (with reason captured for audit).
 */

const LineSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().trim().min(1),
  description: z.string().optional().or(z.literal("")),
  jobId: z.string().uuid().optional().nullable(),
  costCodeId: z.string().uuid().optional().nullable(),
});

const BillSchema = z.object({
  vendorId: z.string().uuid(),
  vendorInvoiceNumber: z.string().optional().or(z.literal("")),
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  discountDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  currency: z.string().length(3).default("USD"),
  exchangeRate: z.string().default("1"),
  discountPercent: z.string().optional().or(z.literal("")),
  description: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  lines: z.array(LineSchema).min(1, "A bill needs at least 1 line."),
});

export type BillInput = z.input<typeof BillSchema>;
export type ActionResult<T = { id: string }> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Create / update (draft only)
// ---------------------------------------------------------------------------

export async function createBill(input: BillInput): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = BillSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const subtotal = sumMoney(parsed.data.lines.map((l) => l.amount));
  const discountPct = money(parsed.data.discountPercent || "0");
  // For v1: total = subtotal. Discount terms affect payment-time math only.
  const total = subtotal;

  try {
    const id = await db.transaction(async (tx) => {
      const billNumber = await nextNumber(tx, organizationId, "AP");

      const [bill] = await tx
        .insert(apBills)
        .values({
          organizationId,
          billNumber,
          vendorInvoiceNumber: parsed.data.vendorInvoiceNumber || null,
          vendorId: parsed.data.vendorId,
          billDate: parsed.data.billDate,
          dueDate: parsed.data.dueDate,
          discountDate: parsed.data.discountDate || null,
          currency: parsed.data.currency.toUpperCase(),
          exchangeRate: parsed.data.exchangeRate || "1",
          subtotalAmount: toDbMoney(subtotal),
          discountPercent: discountPct.toFixed(6),
          totalAmount: toDbMoney(total),
          status: "draft",
          description: parsed.data.description || null,
          notes: parsed.data.notes || null,
        })
        .returning({ id: apBills.id });

      await tx.insert(apBillLines).values(
        parsed.data.lines.map((l, i) => ({
          organizationId,
          billId: bill.id,
          lineNumber: i + 1,
          accountId: l.accountId,
          amount: toDbMoney(l.amount),
          description: l.description || null,
          jobId: l.jobId || null,
          costCodeId: l.costCodeId || null,
        }))
      );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "ap.bill.created",
          entityType: "ap_bill",
          entityId: bill.id,
          metadata: {
            billNumber,
            vendorId: parsed.data.vendorId,
            total: toDbMoney(total),
            lineCount: parsed.data.lines.length,
          },
        },
        tx
      );

      return bill.id;
    });

    revalidatePath("/ap/bills");
    return { ok: true, id };
  } catch (err) {
    console.error("[ap] createBill failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateBill(
  billId: string,
  input: BillInput
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const [bill] = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, billId), eq(apBills.organizationId, organizationId))
    );
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.status !== "draft" && bill.status !== "rejected") {
    return {
      ok: false,
      error: `Cannot edit a ${bill.status} bill. Only draft or rejected bills are editable.`,
    };
  }

  const parsed = BillSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const subtotal = sumMoney(parsed.data.lines.map((l) => l.amount));
  const total = subtotal;

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(apBills)
        .set({
          vendorInvoiceNumber: parsed.data.vendorInvoiceNumber || null,
          vendorId: parsed.data.vendorId,
          billDate: parsed.data.billDate,
          dueDate: parsed.data.dueDate,
          discountDate: parsed.data.discountDate || null,
          currency: parsed.data.currency.toUpperCase(),
          exchangeRate: parsed.data.exchangeRate || "1",
          subtotalAmount: toDbMoney(subtotal),
          discountPercent: parsed.data.discountPercent || "0",
          totalAmount: toDbMoney(total),
          description: parsed.data.description || null,
          notes: parsed.data.notes || null,
          // Clear any prior rejection when editing a rejected bill
          status: "draft",
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          updatedAt: sql`now()`,
        })
        .where(eq(apBills.id, billId));

      // Replace lines
      await tx.delete(apBillLines).where(eq(apBillLines.billId, billId));
      await tx.insert(apBillLines).values(
        parsed.data.lines.map((l, i) => ({
          organizationId,
          billId,
          lineNumber: i + 1,
          accountId: l.accountId,
          amount: toDbMoney(l.amount),
          description: l.description || null,
          jobId: l.jobId || null,
          costCodeId: l.costCodeId || null,
        }))
      );

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "ap.bill.updated",
          entityType: "ap_bill",
          entityId: billId,
          metadata: {
            billNumber: bill.billNumber,
            total: toDbMoney(total),
          },
        },
        tx
      );
    });

    revalidatePath("/ap/bills");
    revalidatePath(`/ap/bills/${billId}`);
    return { ok: true, id: billId };
  } catch (err) {
    console.error("[ap] updateBill failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

export async function submitForApproval(
  billId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const [bill] = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, billId), eq(apBills.organizationId, organizationId))
    );
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.status !== "draft") {
    return {
      ok: false,
      error: `Can only submit draft bills (this one is ${bill.status}).`,
    };
  }

  const routing = await resolveApprovalRouting(
    organizationId,
    "ap_bill",
    bill.totalAmount
  );

  await db.transaction(async (tx) => {
    await tx
      .update(apBills)
      .set({
        status: "pending_approval",
        submittedAt: sql`now()`,
        submittedBy: actor?.id ?? null,
        approvalThresholdId: routing.threshold?.id ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(apBills.id, billId));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "ap.bill.submitted",
        entityType: "ap_bill",
        entityId: billId,
        metadata: {
          billNumber: bill.billNumber,
          total: bill.totalAmount,
          requiredRole: routing.requiredRole,
          fallback: routing.fallback,
        },
      },
      tx
    );
  });

  revalidatePath("/ap/bills");
  revalidatePath(`/ap/bills/${billId}`);
  return { ok: true, id: billId };
}

export async function approveBill(billId: string): Promise<ActionResult> {
  // Must be at least an accountant (we'll raise the bar below based on
  // threshold)
  const { organizationId, role } = await requireRole("accountant");
  const actor = await getUser();

  const [bill] = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, billId), eq(apBills.organizationId, organizationId))
    );
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.status !== "pending_approval") {
    return {
      ok: false,
      error: `Only pending_approval bills can be approved (this one is ${bill.status}).`,
    };
  }

  // Re-resolve routing against CURRENT thresholds — rules may have changed
  // since the bill was submitted.
  const routing = await resolveApprovalRouting(
    organizationId,
    "ap_bill",
    bill.totalAmount
  );
  if (!canApproveAtRole(role, routing.requiredRole)) {
    return {
      ok: false,
      error: `Your role (${role}) can't approve this bill — ${routing.requiredRole} or higher required for ${bill.totalAmount}.`,
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(apBills)
      .set({
        status: "approved",
        approvedAt: sql`now()`,
        approvedBy: actor?.id ?? null,
        approvalThresholdId: routing.threshold?.id ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(apBills.id, billId));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "ap.bill.approved",
        entityType: "ap_bill",
        entityId: billId,
        metadata: {
          billNumber: bill.billNumber,
          total: bill.totalAmount,
          approverRole: role,
          requiredRole: routing.requiredRole,
        },
      },
      tx
    );
  });

  revalidatePath("/ap/bills");
  revalidatePath(`/ap/bills/${billId}`);
  return { ok: true, id: billId };
}

export async function rejectBill(
  billId: string,
  reason: string
): Promise<ActionResult> {
  const { organizationId, role } = await requireRole("accountant");
  const actor = await getUser();

  if (!reason.trim()) {
    return { ok: false, error: "Rejection reason is required." };
  }

  const [bill] = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, billId), eq(apBills.organizationId, organizationId))
    );
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.status !== "pending_approval") {
    return {
      ok: false,
      error: `Only pending_approval bills can be rejected (this one is ${bill.status}).`,
    };
  }

  // Rejection auth mirrors approval — must meet the threshold.
  const routing = await resolveApprovalRouting(
    organizationId,
    "ap_bill",
    bill.totalAmount
  );
  if (!canApproveAtRole(role, routing.requiredRole)) {
    return {
      ok: false,
      error: `Your role (${role}) can't reject this bill — ${routing.requiredRole} or higher required.`,
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(apBills)
      .set({
        status: "rejected",
        rejectedAt: sql`now()`,
        rejectedBy: actor?.id ?? null,
        rejectionReason: reason.trim(),
        updatedAt: sql`now()`,
      })
      .where(eq(apBills.id, billId));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "ap.bill.rejected",
        entityType: "ap_bill",
        entityId: billId,
        metadata: {
          billNumber: bill.billNumber,
          reason: reason.trim(),
          rejectorRole: role,
        },
      },
      tx
    );
  });

  revalidatePath("/ap/bills");
  revalidatePath(`/ap/bills/${billId}`);
  return { ok: true, id: billId };
}

export async function postBill(billId: string): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const [bill] = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, billId), eq(apBills.organizationId, organizationId))
    );
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.status !== "approved") {
    return {
      ok: false,
      error: `Only approved bills can be posted (this one is ${bill.status}).`,
    };
  }

  try {
    await db.transaction(async (tx) => {
      const result = await postBillToGl(tx, {
        bill,
        actorId: actor?.id ?? null,
        organizationId,
      });

      await tx
        .update(apBills)
        .set({
          status: "posted",
          postedAt: sql`now()`,
          postedBy: actor?.id ?? null,
          postingDate: bill.postingDate ?? bill.billDate,
          glJournalId: result.journalId,
          updatedAt: sql`now()`,
        })
        .where(eq(apBills.id, billId));
    });

    revalidatePath("/ap/bills");
    revalidatePath(`/ap/bills/${billId}`);
    revalidatePath("/gl");
    return { ok: true, id: billId };
  } catch (err) {
    console.error("[ap] postBill failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function voidBill(
  billId: string,
  reason: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin"); // void is admin-only
  const actor = await getUser();

  if (!reason.trim()) {
    return { ok: false, error: "Void reason is required." };
  }

  const [bill] = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, billId), eq(apBills.organizationId, organizationId))
    );
  if (!bill) return { ok: false, error: "Bill not found." };
  if (bill.status !== "posted") {
    return {
      ok: false,
      error: `Only posted bills can be voided (this one is ${bill.status}). Use edit/reject for earlier states.`,
    };
  }

  try {
    await db.transaction(async (tx) => {
      const { journalId } = await voidBillFromGl(tx, {
        bill,
        actorId: actor?.id ?? null,
        organizationId,
        reason: reason.trim(),
      });

      await tx
        .update(apBills)
        .set({
          status: "voided",
          voidedAt: sql`now()`,
          voidedBy: actor?.id ?? null,
          voidReason: reason.trim(),
          voidGlJournalId: journalId,
          updatedAt: sql`now()`,
        })
        .where(eq(apBills.id, billId));
    });

    revalidatePath("/ap/bills");
    revalidatePath(`/ap/bills/${billId}`);
    revalidatePath("/gl");
    return { ok: true, id: billId };
  } catch (err) {
    console.error("[ap] voidBill failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Preview: what role will be required for this amount?
// ---------------------------------------------------------------------------

export async function previewApprovalRouting(
  amount: string
): Promise<{
  requiredRole: string;
  tierName: string | null;
  fallback: boolean;
}> {
  const { organizationId } = await requireCurrentOrg();
  const routing = await resolveApprovalRouting(organizationId, "ap_bill", amount);
  return {
    requiredRole: routing.requiredRole,
    tierName: routing.threshold?.tierName ?? null,
    fallback: routing.fallback,
  };
}
