"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  fiscalPeriods,
  organizations,
  type FiscalPeriod,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import { verifyPassword } from "@/lib/auth/password";
import { generateFiscalYear as generateFiscalYearHelper } from "@/lib/gl/fiscal-calendar";

/**
 * Generate a fiscal year with 12 monthly periods. Calendar-year and fiscal-
 * year orgs both supported; the start date is inferred from the org's
 * `fiscal_year_start_month`.
 */
export async function generateFiscalYear(input: {
  yearLabel: string;
  startDate: string; // YYYY-MM-DD
}): Promise<{ ok: true; fiscalYearId: string } | { ok: false; error: string }> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  try {
    const result = await db.transaction(async (tx) => {
      const r = await generateFiscalYearHelper(tx, {
        organizationId,
        yearLabel: input.yearLabel,
        startDate: input.startDate,
      });
      await writeAudit(
        {
          organizationId,
          actorId: actor?.id ?? null,
          event: "fiscal_year.created",
          entityType: "fiscal_year",
          entityId: r.fiscalYearId,
          metadata: { yearLabel: input.yearLabel, startDate: input.startDate },
        },
        tx
      );
      return r;
    });
    revalidatePath("/periods");
    return { ok: true, fiscalYearId: result.fiscalYearId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, error: `FY "${input.yearLabel}" already exists.` };
    }
    console.error("[periods] generateFiscalYear failed:", err);
    return { ok: false, error: "Could not generate fiscal year." };
  }
}

/**
 * Transition a period to a new status.
 *   open -> soft_closed   — any admin
 *   soft_closed -> hard_closed — owner/admin + override password (the same
 *                               password used for hard-close posts); requires
 *                               a reason string for audit
 *   hard_closed -> soft_closed (reopen) — owner only + password + reason
 *   soft_closed -> open — owner/admin
 */
export async function transitionPeriodStatus(input: {
  periodId: string;
  toStatus: FiscalPeriod["status"];
  password?: string;
  reason?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { organizationId, role } = await requireRole("admin");
  const actor = await getUser();

  const [period] = await db
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.id, input.periodId),
        eq(fiscalPeriods.organizationId, organizationId)
      )
    );
  if (!period) return { ok: false, error: "Period not found." };

  // Allowed transitions
  const allowed: Record<string, string[]> = {
    open: ["soft_closed"],
    soft_closed: ["open", "hard_closed"],
    hard_closed: ["soft_closed"],
  };
  if (!allowed[period.status].includes(input.toStatus)) {
    return {
      ok: false,
      error: `Cannot transition from ${period.status} to ${input.toStatus}.`,
    };
  }

  // Password-gated transitions
  const passwordRequired =
    input.toStatus === "hard_closed" ||
    (period.status === "hard_closed" && input.toStatus === "soft_closed");

  if (passwordRequired) {
    if (role !== "owner") {
      return {
        ok: false,
        error: "Hard-close transitions require owner role.",
      };
    }
    if (!input.password) {
      return {
        ok: false,
        error: "Hard-close override password is required.",
      };
    }
    const [org] = await db
      .select({ hash: organizations.hardCloseOverridePasswordHash })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!org?.hash) {
      return {
        ok: false,
        error: "No hard-close override password is configured for this org. Set one in Settings first.",
      };
    }
    const valid = await verifyPassword(input.password, org.hash);
    if (!valid) return { ok: false, error: "Incorrect override password." };
    if (!input.reason?.trim()) {
      return { ok: false, error: "Reason is required for hard-close transitions." };
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(fiscalPeriods)
      .set({
        status: input.toStatus,
        closedAt: input.toStatus === "open" ? null : sql`now()`,
        closedBy: input.toStatus === "open" ? null : actor?.id ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(fiscalPeriods.id, input.periodId));

    await writeAudit(
      {
        organizationId,
        actorId: actor?.id ?? null,
        event: `fiscal_period.${input.toStatus}`,
        entityType: "fiscal_period",
        entityId: input.periodId,
        metadata: {
          from: period.status,
          to: input.toStatus,
          reason: input.reason,
        },
      },
      tx
    );
  });

  revalidatePath("/periods");
  return { ok: true };
}
