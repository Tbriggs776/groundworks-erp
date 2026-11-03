import { eq, sql } from "drizzle-orm";
import { qboImportWatch, type QboImportWatch } from "@/lib/db/schema";
import { db } from "@/lib/db/client";
import type { Ctx } from "@/lib/actor";

/**
 * A batch's black box. A batch commits everything at once, so if the
 * platform kills its function first (a time limit, a crash), the batch
 * leaves nothing behind and the next one repeats it, forever if the same
 * record is too slow every time. So the batch says what it's working on
 * through its own connection (`db`, never the batch's transaction): those
 * writes survive the kill. Committing (or failing with an error) clears
 * it; finding it at the start of a batch means the last one was killed,
 * and on which record.
 *
 * Only the batch holding the import's row lock reads or writes it, so two
 * tabs can't confuse each other.
 */

/** A record that stops this many batches in a row is skipped and noted. */
export const STOPS_TO_SKIP = 2;

export type Stop = { step: string; entity: string; qboId: string; label: string; stops: number };

/**
 * At the start of a batch: if the last batch left its black box, it was
 * killed. Count the stop against the record it was on (a different record
 * starts the count again), and mark this batch as started on `step`.
 * Returns the record that stopped the last batch, if one did.
 */
export async function startWatch(organizationId: string, step: string): Promise<{ stopped: boolean; suspect: Stop | null }> {
  const [left] = await db.select().from(qboImportWatch).where(eq(qboImportWatch.organizationId, organizationId));
  let suspect: Stop | null = suspectOf(left);
  if (left?.entity && left.qboId) {
    const same = suspect && suspect.entity === left.entity && suspect.qboId === left.qboId;
    suspect = {
      step: left.step,
      entity: left.entity,
      qboId: left.qboId,
      label: left.label ?? `${left.entity} ${left.qboId}`,
      stops: same ? suspect!.stops + 1 : 1,
    };
  }
  await db
    .insert(qboImportWatch)
    .values({ organizationId, step, ...suspectColumns(suspect) })
    .onConflictDoUpdate({
      target: qboImportWatch.organizationId,
      set: { step, entity: null, qboId: null, label: null, ...suspectColumns(suspect), touchedAt: sql`now()` },
    });
  return { stopped: Boolean(left), suspect };
}

/**
 * Before each record: what's in flight now. After it (null): nothing, so an
 * error between records (QuickBooks down, say) is never blamed on one.
 */
export async function watchRecord(organizationId: string, step: string, rec: { entity: string; qboId: string; label: string } | null) {
  await db
    .update(qboImportWatch)
    .set({ step, entity: rec?.entity ?? null, qboId: rec?.qboId ?? null, label: rec?.label.slice(0, 200) ?? null, touchedAt: sql`now()` })
    .where(eq(qboImportWatch.organizationId, organizationId));
}

/** The batch committed: inside its transaction, so the clearing commits with the work. */
export async function clearWatchIn(ctx: Ctx) {
  await ctx.tx.delete(qboImportWatch).where(eq(qboImportWatch.organizationId, ctx.actor.organizationId));
}

/** The batch failed with an error (rolled back, reported): nothing was killed. */
export async function clearWatch(organizationId: string) {
  await db.delete(qboImportWatch).where(eq(qboImportWatch.organizationId, organizationId));
}

/**
 * For the page: a black box nobody has touched for longer than a batch can
 * run means the last batch was killed and nothing has run since.
 */
export async function readInterrupted(ctx: Ctx, staleAfterSeconds: number): Promise<{ label: string | null; at: Date } | null> {
  const [w] = await ctx.tx
    .select()
    .from(qboImportWatch)
    .where(eq(qboImportWatch.organizationId, ctx.actor.organizationId));
  if (!w || Date.now() - w.touchedAt.getTime() < staleAfterSeconds * 1000) return null;
  return { label: w.label, at: w.touchedAt };
}

function suspectOf(w: QboImportWatch | undefined): Stop | null {
  if (!w?.suspectEntity || !w.suspectQboId || !w.suspectStep) return null;
  return { step: w.suspectStep, entity: w.suspectEntity, qboId: w.suspectQboId, label: w.suspectLabel ?? "", stops: w.stops };
}

function suspectColumns(s: Stop | null) {
  return {
    suspectStep: s?.step ?? null,
    suspectEntity: s?.entity ?? null,
    suspectQboId: s?.qboId ?? null,
    suspectLabel: s?.label ?? null,
    stops: s?.stops ?? 0,
  };
}
