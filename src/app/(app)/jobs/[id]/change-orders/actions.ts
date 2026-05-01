"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  changeOrderLines,
  changeOrders,
  costCodes,
  jobs,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import {
  canApproveAtRole,
  resolveApprovalRouting,
} from "@/lib/ap/approval";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import {
  executeChangeOrder,
  voidExecutedChangeOrder,
} from "@/lib/projects/change-orders";

export type ActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

const HeaderSchema = z.object({
  jobId: z.string().uuid(),
  description: z.string().trim().min(1).max(500),
  externalReference: z.string().optional().or(z.literal("")),
  contractAdjustment: z.string().optional().or(z.literal("")),
  scheduleAdjustmentDays: z.coerce.number().int().default(0),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

const LineSchema = z.object({
  costCodeId: z.string().uuid(),
  amount: z.string().trim().min(1),
  description: z.string().optional().or(z.literal("")),
});

const UpsertSchema = z.object({
  changeOrderId: z.string().uuid().optional(),
  header: HeaderSchema,
  lines: z.array(LineSchema),
});

/**
 * Create or update a change order. While status='draft' all fields are
 * editable; once submitted the only path back to editing is rejection.
 *
 * If `changeOrderId` is provided we update + replace lines; otherwise
 * we insert a new draft and allocate a CO number from the CO series.
 */
export async function upsertChangeOrder(
  input: z.input<typeof UpsertSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const parsed = UpsertSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  // Verify job is on this org and not closed
  const [job] = await db
    .select({ id: jobs.id, code: jobs.code, status: jobs.status })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, parsed.data.header.jobId),
        eq(jobs.organizationId, organizationId)
      )
    );
  if (!job) return { ok: false, error: "Job not found." };
  if (job.status === "closed") {
    return { ok: false, error: "Cannot create change orders on closed jobs." };
  }

  // Validate every cost code on the lines belongs to this org + active
  if (parsed.data.lines.length > 0) {
    const ids = Array.from(new Set(parsed.data.lines.map((l) => l.costCodeId)));
    const found = await db
      .select({
        id: costCodes.id,
        code: costCodes.code,
        isActive: costCodes.isActive,
      })
      .from(costCodes)
      .where(
        and(
          eq(costCodes.organizationId, organizationId),
          sql`${costCodes.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )}])`
        )
      );
    if (found.length !== ids.length) {
      return { ok: false, error: "One or more cost codes are not in this org." };
    }
    const inactive = found.filter((c) => !c.isActive);
    if (inactive.length > 0) {
      return {
        ok: false,
        error: `Inactive cost code(s): ${inactive.map((c) => c.code).join(", ")}`,
      };
    }
  }

  try {
    const id = await db.transaction(async (tx) => {
      let coId = parsed.data.changeOrderId;

      if (coId) {
        // Update path — only allowed when status='draft'
        const [existing] = await tx
          .select()
          .from(changeOrders)
          .where(
            and(
              eq(changeOrders.id, coId),
              eq(changeOrders.organizationId, organizationId)
            )
          );
        if (!existing) throw new Error("Change order not found.");
        if (existing.status !== "draft") {
          throw new Error(
            `Cannot edit change order in status '${existing.status}'. Reject it first to send back to draft.`
          );
        }

        await tx
          .update(changeOrders)
          .set({
            description: parsed.data.header.description,
            externalReference: parsed.data.header.externalReference || null,
            contractAdjustment: toDbMoney(
              parsed.data.header.contractAdjustment || "0"
            ),
            scheduleAdjustmentDays: parsed.data.header.scheduleAdjustmentDays,
            effectiveDate: parsed.data.header.effectiveDate || null,
            notes: parsed.data.header.notes || null,
            updatedAt: sql`now()`,
          })
          .where(eq(changeOrders.id, coId));

        // Replace lines
        await tx
          .delete(changeOrderLines)
          .where(eq(changeOrderLines.changeOrderId, coId));
      } else {
        const coNumber = await nextNumber(tx, organizationId, "CO");
        const [row] = await tx
          .insert(changeOrders)
          .values({
            organizationId,
            jobId: parsed.data.header.jobId,
            coNumber,
            description: parsed.data.header.description,
            externalReference: parsed.data.header.externalReference || null,
            contractAdjustment: toDbMoney(
              parsed.data.header.contractAdjustment || "0"
            ),
            scheduleAdjustmentDays: parsed.data.header.scheduleAdjustmentDays,
            effectiveDate: parsed.data.header.effectiveDate || null,
            notes: parsed.data.header.notes || null,
            status: "draft",
          })
          .returning({ id: changeOrders.id });
        coId = row.id;
      }

      if (parsed.data.lines.length > 0) {
        await tx.insert(changeOrderLines).values(
          parsed.data.lines.map((l, i) => ({
            organizationId,
            changeOrderId: coId!,
            lineNumber: i + 1,
            costCodeId: l.costCodeId,
            amount: toDbMoney(l.amount),
            description: l.description || null,
          }))
        );
      }

      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: parsed.data.changeOrderId
            ? "change_order.updated"
            : "change_order.created",
          entityType: "change_order",
          entityId: coId!,
          metadata: {
            jobId: parsed.data.header.jobId,
            jobCode: job.code,
            contractAdjustment: parsed.data.header.contractAdjustment || "0",
            lineCount: parsed.data.lines.length,
          },
        },
        tx
      );

      return coId!;
    });

    revalidatePath(`/jobs/${parsed.data.header.jobId}`);
    revalidatePath(`/jobs/${parsed.data.header.jobId}/change-orders`);
    revalidatePath(`/jobs/${parsed.data.header.jobId}/change-orders/${id}`);
    return { ok: true, id };
  } catch (err) {
    console.error("[change-orders] upsert failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Submit a draft change order for approval. Resolves the matching
 * approval threshold based on the absolute value of contractAdjustment.
 * (We use absolute value so a $50k de-scope routes the same as a $50k
 * up-charge — both have material P&L impact.)
 */
export async function submitChangeOrder(
  changeOrderId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const [co] = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.id, changeOrderId),
        eq(changeOrders.organizationId, organizationId)
      )
    );
  if (!co) return { ok: false, error: "Change order not found." };
  if (co.status !== "draft") {
    return {
      ok: false,
      error: `Can only submit draft change orders (this one is ${co.status}).`,
    };
  }

  // Lines must exist
  const lines = await db
    .select()
    .from(changeOrderLines)
    .where(eq(changeOrderLines.changeOrderId, co.id));
  if (lines.length === 0) {
    return {
      ok: false,
      error: "Cannot submit a change order with no lines.",
    };
  }

  const routingAmount = money(co.contractAdjustment).abs();
  const routing = await resolveApprovalRouting(
    organizationId,
    "change_order",
    routingAmount.toFixed(4)
  );

  await db.transaction(async (tx) => {
    await tx
      .update(changeOrders)
      .set({
        status: "pending_approval",
        submittedAt: sql`now()`,
        submittedBy: actor?.id ?? null,
        approvalThresholdId: routing.threshold?.id ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(changeOrders.id, co.id));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "change_order.submitted",
        entityType: "change_order",
        entityId: co.id,
        metadata: {
          coNumber: co.coNumber,
          contractAdjustment: co.contractAdjustment,
          requiredRole: routing.requiredRole,
          fallback: routing.fallback,
        },
      },
      tx
    );
  });

  revalidatePath(`/jobs/${co.jobId}/change-orders`);
  revalidatePath(`/jobs/${co.jobId}/change-orders/${co.id}`);
  return { ok: true, id: co.id };
}

export async function approveChangeOrder(
  changeOrderId: string
): Promise<ActionResult> {
  const { organizationId, role } = await requireRole("accountant");
  const actor = await getUser();

  const [co] = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.id, changeOrderId),
        eq(changeOrders.organizationId, organizationId)
      )
    );
  if (!co) return { ok: false, error: "Change order not found." };
  if (co.status !== "pending_approval") {
    return {
      ok: false,
      error: `Only pending_approval can be approved (this one is ${co.status}).`,
    };
  }

  const routingAmount = money(co.contractAdjustment).abs();
  const routing = await resolveApprovalRouting(
    organizationId,
    "change_order",
    routingAmount.toFixed(4)
  );
  if (!canApproveAtRole(role, routing.requiredRole)) {
    return {
      ok: false,
      error: `Your role (${role}) can't approve this CO — ${routing.requiredRole} or higher required.`,
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(changeOrders)
      .set({
        status: "approved",
        approvedAt: sql`now()`,
        approvedBy: actor?.id ?? null,
        approvalThresholdId: routing.threshold?.id ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(changeOrders.id, co.id));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "change_order.approved",
        entityType: "change_order",
        entityId: co.id,
        metadata: {
          coNumber: co.coNumber,
          approverRole: role,
          requiredRole: routing.requiredRole,
        },
      },
      tx
    );
  });

  revalidatePath(`/jobs/${co.jobId}/change-orders`);
  revalidatePath(`/jobs/${co.jobId}/change-orders/${co.id}`);
  return { ok: true, id: co.id };
}

export async function rejectChangeOrder(
  changeOrderId: string,
  reason: string
): Promise<ActionResult> {
  const { organizationId, role } = await requireRole("accountant");
  const actor = await getUser();

  if (!reason.trim()) {
    return { ok: false, error: "Rejection reason is required." };
  }

  const [co] = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.id, changeOrderId),
        eq(changeOrders.organizationId, organizationId)
      )
    );
  if (!co) return { ok: false, error: "Change order not found." };
  if (co.status !== "pending_approval") {
    return {
      ok: false,
      error: `Only pending_approval can be rejected (this one is ${co.status}).`,
    };
  }

  const routingAmount = money(co.contractAdjustment).abs();
  const routing = await resolveApprovalRouting(
    organizationId,
    "change_order",
    routingAmount.toFixed(4)
  );
  if (!canApproveAtRole(role, routing.requiredRole)) {
    return {
      ok: false,
      error: `Your role (${role}) can't reject this CO — ${routing.requiredRole} or higher required.`,
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(changeOrders)
      .set({
        status: "rejected",
        rejectedAt: sql`now()`,
        rejectedBy: actor?.id ?? null,
        rejectionReason: reason,
        updatedAt: sql`now()`,
      })
      .where(eq(changeOrders.id, co.id));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "change_order.rejected",
        entityType: "change_order",
        entityId: co.id,
        metadata: {
          coNumber: co.coNumber,
          reason,
          rejectorRole: role,
        },
      },
      tx
    );
  });

  revalidatePath(`/jobs/${co.jobId}/change-orders`);
  revalidatePath(`/jobs/${co.jobId}/change-orders/${co.id}`);
  return { ok: true, id: co.id };
}

/**
 * Reopen a rejected change order back to draft so the requester can
 * fix it and re-submit. PM-level — same role that owns the create.
 */
export async function reopenChangeOrder(
  changeOrderId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const [co] = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.id, changeOrderId),
        eq(changeOrders.organizationId, organizationId)
      )
    );
  if (!co) return { ok: false, error: "Change order not found." };
  if (co.status !== "rejected") {
    return {
      ok: false,
      error: `Only rejected change orders can be reopened (this one is ${co.status}).`,
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(changeOrders)
      .set({
        status: "draft",
        updatedAt: sql`now()`,
      })
      .where(eq(changeOrders.id, co.id));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "change_order.reopened",
        entityType: "change_order",
        entityId: co.id,
        metadata: { coNumber: co.coNumber },
      },
      tx
    );
  });

  revalidatePath(`/jobs/${co.jobId}/change-orders/${co.id}`);
  return { ok: true, id: co.id };
}

/**
 * Execute an approved change order — applies the contract bump and
 * per-line budget bumps to the job. Wraps the library helper.
 */
export async function executeApprovedChangeOrder(
  changeOrderId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const [co] = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.id, changeOrderId),
        eq(changeOrders.organizationId, organizationId)
      )
    );
  if (!co) return { ok: false, error: "Change order not found." };
  if (co.status !== "approved") {
    return {
      ok: false,
      error: `Only approved change orders can be executed (this one is ${co.status}).`,
    };
  }

  try {
    await db.transaction(async (tx) => {
      await executeChangeOrder(tx, {
        co,
        actorId: actor?.id ?? null,
        organizationId,
      });
    });
  } catch (err) {
    console.error("[change-orders] execute failed:", err);
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath(`/jobs/${co.jobId}`);
  revalidatePath(`/jobs/${co.jobId}/budget`);
  revalidatePath(`/jobs/${co.jobId}/change-orders`);
  revalidatePath(`/jobs/${co.jobId}/change-orders/${co.id}`);
  return { ok: true, id: co.id };
}

/**
 * Void an executed change order — reverses the contract + budget
 * bumps. Admin-only since it modifies an executed contract.
 */
export async function voidChangeOrder(
  changeOrderId: string,
  reason: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  if (!reason.trim()) {
    return { ok: false, error: "Reason is required." };
  }

  const [co] = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.id, changeOrderId),
        eq(changeOrders.organizationId, organizationId)
      )
    );
  if (!co) return { ok: false, error: "Change order not found." };
  if (co.status !== "executed") {
    return {
      ok: false,
      error: `Only executed change orders can be voided (this one is ${co.status}).`,
    };
  }

  try {
    await db.transaction(async (tx) => {
      await voidExecutedChangeOrder(tx, {
        co,
        actorId: actor?.id ?? null,
        organizationId,
        reason,
      });
    });
  } catch (err) {
    console.error("[change-orders] void failed:", err);
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath(`/jobs/${co.jobId}`);
  revalidatePath(`/jobs/${co.jobId}/budget`);
  revalidatePath(`/jobs/${co.jobId}/change-orders`);
  revalidatePath(`/jobs/${co.jobId}/change-orders/${co.id}`);
  return { ok: true, id: co.id };
}

/**
 * Delete a draft change order (cleanup). Anything past draft must go
 * through reject + (later) void instead.
 */
export async function deleteDraftChangeOrder(
  changeOrderId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const [co] = await db
    .select()
    .from(changeOrders)
    .where(
      and(
        eq(changeOrders.id, changeOrderId),
        eq(changeOrders.organizationId, organizationId)
      )
    );
  if (!co) return { ok: false, error: "Change order not found." };
  if (co.status !== "draft") {
    return {
      ok: false,
      error: `Only draft change orders can be deleted (this one is ${co.status}).`,
    };
  }

  await db.transaction(async (tx) => {
    await tx.delete(changeOrders).where(eq(changeOrders.id, co.id));
    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "change_order.deleted",
        entityType: "change_order",
        entityId: co.id,
        metadata: { coNumber: co.coNumber },
      },
      tx
    );
  });

  revalidatePath(`/jobs/${co.jobId}/change-orders`);
  return { ok: true, id: co.id };
}

// unused-import guard
void sumMoney;
