"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUser, requireRole } from "@/lib/auth";
import { createAndPostJournal } from "@/lib/gl/posting";

/**
 * Server action wrapper around createAndPostJournal for the manual JE form.
 * Gated to accountant+ so field users can't post random JEs.
 */

const LineSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: z.string().trim(),
    credit: z.string().trim(),
    memo: z.string().trim().optional().or(z.literal("")),
  })
  .refine(
    (l) => {
      const d = Number(l.debit || 0);
      const c = Number(l.credit || 0);
      return (d > 0 && c === 0) || (c > 0 && d === 0);
    },
    { message: "Each line must have either a debit or a credit (not both)." }
  );

const Schema = z.object({
  journalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceCodeId: z.string().uuid(),
  description: z.string().trim().min(1).max(500),
  reasonCodeId: z.string().uuid().optional().nullable(),
  currency: z.string().default("USD"),
  lines: z.array(LineSchema).min(2, "A journal needs at least 2 lines."),
});

export type PostJeInput = z.infer<typeof Schema>;
export type PostJeResult =
  | { ok: true; journalId: string; journalNumber: string }
  | { ok: false; error: string; code?: string };

export async function postManualJournal(input: PostJeInput): Promise<PostJeResult> {
  const { organizationId } = await requireRole("accountant");
  const actor = await getUser();

  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const r = await createAndPostJournal({
    organizationId,
    actorId: actor?.id ?? null,
    journalDate: parsed.data.journalDate,
    sourceCodeId: parsed.data.sourceCodeId,
    source: "manual",
    description: parsed.data.description,
    reasonCodeId: parsed.data.reasonCodeId ?? undefined,
    currency: parsed.data.currency,
    lines: parsed.data.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit || undefined,
      credit: l.credit || undefined,
      memo: l.memo || undefined,
    })),
  });

  if (!r.ok) {
    return { ok: false, error: r.error, code: r.code };
  }

  revalidatePath("/gl");
  return { ok: true, journalId: r.journalId, journalNumber: r.journalNumber };
}
