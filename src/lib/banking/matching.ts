import { and, eq } from "drizzle-orm";
import { bankStatementLines, bankStatementMatches, glLineClearings, glLines } from "@/lib/db/schema";
import type { Ctx } from "@/lib/actor";

/** Mark ledger lines on a bank account cleared (left alone if already cleared or reconciled). */
export async function clearLedgerLines(ctx: Ctx, accountId: string, glLineIds: string[], reconciliationId?: string) {
  if (glLineIds.length === 0) return;
  await ctx.tx
    .insert(glLineClearings)
    .values(
      glLineIds.map((glLineId) => ({
        glLineId,
        organizationId: ctx.actor.organizationId,
        accountId,
        status: "cleared" as const,
        reconciliationId: reconciliationId ?? null,
        clearedBy: ctx.actor.userId,
        clearedByAgentId: ctx.actor.agentId,
      }))
    )
    .onConflictDoNothing();
}

/**
 * A bank transaction created from a statement line ("Add") just posted:
 * tie the line to the bank-side ledger line and clear it, as QuickBooks
 * does. No-op for transactions entered by hand.
 */
export async function linkPostedTransactionToStatement(ctx: Ctx, txnId: string, journalId: string) {
  const [line] = await ctx.tx
    .select({ id: bankStatementLines.id, accountId: bankStatementLines.accountId })
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.organizationId, ctx.actor.organizationId), eq(bankStatementLines.bankTransactionId, txnId)));
  if (!line) return;
  const [gl] = await ctx.tx
    .select({ id: glLines.id })
    .from(glLines)
    .where(and(eq(glLines.journalId, journalId), eq(glLines.accountId, line.accountId)))
    .limit(1);
  if (!gl) return;
  await ctx.tx
    .insert(bankStatementMatches)
    .values({ organizationId: ctx.actor.organizationId, statementLineId: line.id, glLineId: gl.id })
    .onConflictDoNothing();
  await clearLedgerLines(ctx, line.accountId, [gl.id]);
}
