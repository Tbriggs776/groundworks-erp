"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { serviceAction } from "@/lib/action";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";
import * as close from "@/lib/gl/close";
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

/** Close, reopen, and checklist actions: thin wrappers over src/lib/gl/close.ts. */
export async function closePeriodAction(input: { id: string; level: "soft" | "hard"; note?: string; password?: string }) {
  const r = await serviceAction("admin", (ctx) => close.closePeriod(ctx, input));
  if (r.ok) revalidatePath("/periods", "layout");
  return r;
}

export async function reopenPeriodAction(input: { id: string; reason: string; password?: string }) {
  const r = await serviceAction("admin", (ctx) => close.reopenPeriod(ctx, input));
  if (r.ok) revalidatePath("/periods", "layout");
  return r;
}

export async function setCloseTaskAction(input: { id: string; taskId: string; done: boolean; note?: string }) {
  const r = await serviceAction("bookkeeper", (ctx) => close.setCloseTask(ctx, input));
  if (r.ok) revalidatePath(`/periods/${input.id}`);
  return r;
}

export async function createCloseTaskAction(input: { title: string; description?: string }) {
  const r = await serviceAction("accountant", async (ctx) => ({ task: await close.createCloseTask(ctx, input) }));
  if (r.ok) revalidatePath("/periods", "layout");
  return r;
}

export async function updateCloseTaskAction(input: { id: string; isActive: boolean }) {
  const r = await serviceAction("accountant", async (ctx) => ({ task: await close.updateCloseTask(ctx, input) }));
  if (r.ok) revalidatePath("/periods", "layout");
  return r;
}

export async function setClosingPasswordAction(input: { password: string; currentPassword?: string }) {
  return serviceAction("owner", (ctx) => close.setClosingPassword(ctx, input));
}
