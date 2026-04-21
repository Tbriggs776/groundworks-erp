"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { exchangeRates } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { getUser, requireRole } from "@/lib/auth";

const RateSchema = z
  .object({
    fromCurrency: z.string().trim().length(3),
    toCurrency: z.string().trim().length(3),
    rateType: z.enum(["spot", "average", "historical", "budget", "consolidation"]),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rate: z.string().trim().min(1),
    inverseRate: z.string().trim().optional(),
  })
  .refine((r) => r.fromCurrency !== r.toCurrency, {
    message: "From and To must differ.",
    path: ["toCurrency"],
  })
  .refine((r) => Number(r.rate) > 0, {
    message: "Rate must be positive.",
    path: ["rate"],
  });

export type ActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function createExchangeRate(
  input: z.input<typeof RateSchema>
): Promise<ActionResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = RateSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const rate = parsed.data.rate;
  // If inverse isn't provided, compute it to ~10 decimal places.
  const inverse =
    parsed.data.inverseRate && Number(parsed.data.inverseRate) > 0
      ? parsed.data.inverseRate
      : (1 / Number(rate)).toFixed(10);

  try {
    const [row] = await db
      .insert(exchangeRates)
      .values({
        organizationId,
        fromCurrency: parsed.data.fromCurrency.toUpperCase(),
        toCurrency: parsed.data.toCurrency.toUpperCase(),
        rateType: parsed.data.rateType,
        effectiveDate: parsed.data.effectiveDate,
        rate,
        inverseRate: inverse,
      })
      .returning({ id: exchangeRates.id });

    await writeAudit({
      organizationId,
      actorId: actor?.id ?? null,
      event: "exchange_rate.created",
      entityType: "exchange_rate",
      entityId: row.id,
      metadata: parsed.data,
    });

    revalidatePath("/rates");
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return {
        ok: false,
        error:
          "A rate already exists for this pair, type, and date. Use a different effective date.",
      };
    }
    console.error("[rates] createExchangeRate failed:", err);
    return { ok: false, error: (err as Error).message };
  }
}
