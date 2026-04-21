"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sourceCodes } from "@/lib/db/schema";
import { getUser, requireRole } from "@/lib/auth";
import {
  computeFxAdjustments,
  runFxRevaluation,
  type FxAdjustmentSummary,
  type RevaluationResult,
} from "@/lib/gl/fx-revaluation";

export async function previewRevaluation(
  asOfDate: string
): Promise<FxAdjustmentSummary> {
  const { organizationId } = await requireRole("accountant");
  return computeFxAdjustments(organizationId, asOfDate);
}

export async function postRevaluation(input: {
  asOfDate: string;
  fxGainAccountId: string;
  fxLossAccountId: string;
  autoReverseDate?: string;
}): Promise<RevaluationResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  // Look up ADJ source code
  const [adjSrc] = await db
    .select({ id: sourceCodes.id })
    .from(sourceCodes)
    .where(
      and(
        eq(sourceCodes.organizationId, organizationId),
        eq(sourceCodes.code, "ADJ")
      )
    );
  if (!adjSrc) {
    return {
      ok: false,
      error: "ADJ source code missing. Re-run org seeding.",
    };
  }

  const r = await runFxRevaluation({
    organizationId,
    actorId: actor?.id ?? null,
    asOfDate: input.asOfDate,
    fxGainAccountId: input.fxGainAccountId,
    fxLossAccountId: input.fxLossAccountId,
    sourceCodeId: adjSrc.id,
    autoReverseDate: input.autoReverseDate,
  });
  if (r.ok) {
    revalidatePath("/gl");
    revalidatePath("/rates/revaluation");
  }
  return r;
}
