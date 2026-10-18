"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as journals from "@/lib/gl/journals";

/**
 * Manual JE form → journals service (src/lib/gl/journals.ts). The form
 * posts immediately; drafts come from agents and the API.
 */
export type PostJeInput = {
  journalDate: string;
  sourceCodeId: string;
  description: string;
  reasonCodeId?: string | null;
  currency?: string;
  lines: Array<{ accountId: string; debit: string; credit: string; memo?: string }>;
};

export async function postManualJournal(
  input: PostJeInput
): Promise<ActionResult<{ journalId: string; journalNumber: string }>> {
  const r = await serviceAction("accountant", async (ctx) => {
    const j = await journals.createJournalEntry(ctx, {
      date: input.journalDate,
      sourceCodeId: input.sourceCodeId,
      description: input.description,
      reasonCodeId: input.reasonCodeId ?? undefined,
      currency: input.currency,
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit || undefined,
        credit: l.credit || undefined,
        memo: l.memo,
      })),
      post: true,
    });
    return { journalId: j.id, journalNumber: j.journalNumber };
  });
  if (r.ok) revalidatePath("/gl");
  return r;
}
