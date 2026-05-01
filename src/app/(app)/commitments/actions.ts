"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  accounts,
  commitmentLines,
  commitments,
  costCodes,
  jobs,
  vendors,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import { nextNumber } from "@/lib/gl/number-series";
import { sumMoney, toDbMoney } from "@/lib/money";
import {
  closeIssuedCommitment,
  issueCommitment,
  voidIssuedCommitment,
} from "@/lib/projects/commitments";

export type ActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

const HeaderSchema = z.object({
  jobId: z.string().uuid(),
  vendorId: z.string().uuid(),
  type: z.enum(["po", "subcontract"]).default("po"),
  description: z.string().trim().min(1).max(500),
  externalReference: z.string().optional().or(z.literal("")),
  currency: z.string().trim().min(3).max(3).default("USD"),
  exchangeRate: z.string().optional().or(z.literal("")),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("")),
  expirationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

const LineSchema = z.object({
  accountId: z.string().uuid(),
  costCodeId: z.string().uuid(),
  amount: z.string().trim().min(1),
  description: z.string().optional().or(z.literal("")),
});

const UpsertSchema = z.object({
  commitmentId: z.string().uuid().optional(),
  header: HeaderSchema,
  lines: z.array(LineSchema),
});

/**
 * Create or update a commitment. Drafts are fully editable; once
 * issued the only path back is void + recreate.
 */
export async function upsertCommitment(
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

  // Job belongs to org and is open
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
    return { ok: false, error: "Cannot create commitments on closed jobs." };
  }

  // Vendor belongs to org
  const [vendor] = await db
    .select({ id: vendors.id, code: vendors.code })
    .from(vendors)
    .where(
      and(
        eq(vendors.id, parsed.data.header.vendorId),
        eq(vendors.organizationId, organizationId)
      )
    );
  if (!vendor) return { ok: false, error: "Vendor not found." };

  // Validate lines: all account + cost code IDs belong to this org
  if (parsed.data.lines.length > 0) {
    const ccIds = Array.from(
      new Set(parsed.data.lines.map((l) => l.costCodeId))
    );
    const acctIds = Array.from(
      new Set(parsed.data.lines.map((l) => l.accountId))
    );

    const ccFound = await db
      .select({
        id: costCodes.id,
        code: costCodes.code,
        isActive: costCodes.isActive,
      })
      .from(costCodes)
      .where(
        and(
          eq(costCodes.organizationId, organizationId),
          inArray(costCodes.id, ccIds)
        )
      );
    if (ccFound.length !== ccIds.length) {
      return { ok: false, error: "One or more cost codes are not in this org." };
    }
    const inactiveCC = ccFound.filter((c) => !c.isActive);
    if (inactiveCC.length > 0) {
      return {
        ok: false,
        error: `Inactive cost code(s): ${inactiveCC.map((c) => c.code).join(", ")}`,
      };
    }

    const acctFound = await db
      .select({
        id: accounts.id,
        code: accounts.code,
        isActive: accounts.isActive,
        directPosting: accounts.directPosting,
        accountType: accounts.accountType,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          inArray(accounts.id, acctIds)
        )
      );
    if (acctFound.length !== acctIds.length) {
      return { ok: false, error: "One or more accounts are not in this org." };
    }
    const bad = acctFound.filter(
      (a) => !a.isActive || !a.directPosting || a.accountType !== "posting"
    );
    if (bad.length > 0) {
      return {
        ok: false,
        error: `Account(s) not eligible for direct posting: ${bad
          .map((a) => a.code)
          .join(", ")}`,
      };
    }
  }

  const total = sumMoney(parsed.data.lines.map((l) => l.amount));

  try {
    const id = await db.transaction(async (tx) => {
      let commitmentId = parsed.data.commitmentId;

      if (commitmentId) {
        const [existing] = await tx
          .select()
          .from(commitments)
          .where(
            and(
              eq(commitments.id, commitmentId),
              eq(commitments.organizationId, organizationId)
            )
          );
        if (!existing) throw new Error("Commitment not found.");
        if (existing.status !== "draft") {
          throw new Error(
            `Cannot edit commitment in status '${existing.status}'. Void it and start over to make changes.`
          );
        }

        await tx
          .update(commitments)
          .set({
            jobId: parsed.data.header.jobId,
            vendorId: parsed.data.header.vendorId,
            type: parsed.data.header.type,
            description: parsed.data.header.description,
            externalReference: parsed.data.header.externalReference || null,
            currency: parsed.data.header.currency,
            exchangeRate: parsed.data.header.exchangeRate || "1",
            totalAmount: toDbMoney(total),
            effectiveDate: parsed.data.header.effectiveDate || null,
            expirationDate: parsed.data.header.expirationDate || null,
            notes: parsed.data.header.notes || null,
            updatedAt: sql`now()`,
          })
          .where(eq(commitments.id, commitmentId));

        await tx
          .delete(commitmentLines)
          .where(eq(commitmentLines.commitmentId, commitmentId));
      } else {
        // Allocate a number from the appropriate series (PO or SUB).
        const seriesCode = parsed.data.header.type === "subcontract" ? "SUB" : "PO";
        const commitmentNumber = await nextNumber(
          tx,
          organizationId,
          seriesCode
        );

        const [row] = await tx
          .insert(commitments)
          .values({
            organizationId,
            jobId: parsed.data.header.jobId,
            vendorId: parsed.data.header.vendorId,
            commitmentNumber,
            externalReference: parsed.data.header.externalReference || null,
            type: parsed.data.header.type,
            status: "draft",
            description: parsed.data.header.description,
            currency: parsed.data.header.currency,
            exchangeRate: parsed.data.header.exchangeRate || "1",
            totalAmount: toDbMoney(total),
            effectiveDate: parsed.data.header.effectiveDate || null,
            expirationDate: parsed.data.header.expirationDate || null,
            notes: parsed.data.header.notes || null,
          })
          .returning({ id: commitments.id });
        commitmentId = row.id;
      }

      if (parsed.data.lines.length > 0) {
        await tx.insert(commitmentLines).values(
          parsed.data.lines.map((l, i) => ({
            organizationId,
            commitmentId: commitmentId!,
            lineNumber: i + 1,
            accountId: l.accountId,
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
          event: parsed.data.commitmentId
            ? "commitment.updated"
            : "commitment.created",
          entityType: "commitment",
          entityId: commitmentId!,
          metadata: {
            jobId: parsed.data.header.jobId,
            jobCode: job.code,
            vendorCode: vendor.code,
            type: parsed.data.header.type,
            totalAmount: toDbMoney(total),
            lineCount: parsed.data.lines.length,
          },
        },
        tx
      );

      return commitmentId!;
    });

    revalidatePath("/commitments");
    revalidatePath(`/jobs/${parsed.data.header.jobId}`);
    revalidatePath(`/jobs/${parsed.data.header.jobId}/commitments`);
    revalidatePath(`/commitments/${id}`);
    return { ok: true, id };
  } catch (err) {
    console.error("[commitments] upsert failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function issueCommitmentAction(
  commitmentId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const [c] = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.id, commitmentId),
        eq(commitments.organizationId, organizationId)
      )
    );
  if (!c) return { ok: false, error: "Commitment not found." };

  try {
    await db.transaction(async (tx) => {
      await issueCommitment(tx, {
        commitment: c,
        actorId: actor?.id ?? null,
        organizationId,
      });
    });
  } catch (err) {
    console.error("[commitments] issue failed:", err);
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath("/commitments");
  revalidatePath(`/jobs/${c.jobId}`);
  revalidatePath(`/jobs/${c.jobId}/commitments`);
  revalidatePath(`/commitments/${commitmentId}`);
  return { ok: true, id: commitmentId };
}

export async function closeCommitmentAction(
  commitmentId: string,
  reason?: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const [c] = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.id, commitmentId),
        eq(commitments.organizationId, organizationId)
      )
    );
  if (!c) return { ok: false, error: "Commitment not found." };

  try {
    await db.transaction(async (tx) => {
      await closeIssuedCommitment(tx, {
        commitment: c,
        actorId: actor?.id ?? null,
        organizationId,
        reason,
      });
    });
  } catch (err) {
    console.error("[commitments] close failed:", err);
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath("/commitments");
  revalidatePath(`/jobs/${c.jobId}`);
  revalidatePath(`/jobs/${c.jobId}/commitments`);
  revalidatePath(`/commitments/${commitmentId}`);
  return { ok: true, id: commitmentId };
}

export async function voidCommitmentAction(
  commitmentId: string,
  reason: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("admin");
  const actor = await getUser();

  if (!reason.trim()) {
    return { ok: false, error: "Reason is required." };
  }

  const [c] = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.id, commitmentId),
        eq(commitments.organizationId, organizationId)
      )
    );
  if (!c) return { ok: false, error: "Commitment not found." };

  try {
    await db.transaction(async (tx) => {
      await voidIssuedCommitment(tx, {
        commitment: c,
        actorId: actor?.id ?? null,
        organizationId,
        reason,
      });
    });
  } catch (err) {
    console.error("[commitments] void failed:", err);
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath("/commitments");
  revalidatePath(`/jobs/${c.jobId}`);
  revalidatePath(`/jobs/${c.jobId}/commitments`);
  revalidatePath(`/commitments/${commitmentId}`);
  return { ok: true, id: commitmentId };
}

export async function deleteDraftCommitment(
  commitmentId: string
): Promise<ActionResult> {
  const { organizationId } = await requireRole("pm");
  const actor = await getUser();

  const [c] = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.id, commitmentId),
        eq(commitments.organizationId, organizationId)
      )
    );
  if (!c) return { ok: false, error: "Commitment not found." };
  if (c.status !== "draft") {
    return {
      ok: false,
      error: `Only drafts can be deleted (this one is ${c.status}).`,
    };
  }

  await db.transaction(async (tx) => {
    await tx.delete(commitments).where(eq(commitments.id, c.id));
    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: "commitment.deleted",
        entityType: "commitment",
        entityId: c.id,
        metadata: { commitmentNumber: c.commitmentNumber },
      },
      tx
    );
  });

  revalidatePath("/commitments");
  revalidatePath(`/jobs/${c.jobId}/commitments`);
  return { ok: true, id: commitmentId };
}
