import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { idempotencyKeys } from "@/lib/db/schema";
import { runAs, type Actor } from "@/lib/actor";
import { AppError, toAppError } from "@/lib/errors";
import { isMutation, type Operation } from "./operations";

/**
 * Run one registry operation for an authenticated actor — the shared core
 * under REST and MCP.
 *
 *   dryRun          run everything (validation, numbering, GL posting) in a
 *                   transaction, then roll it back and return what WOULD
 *                   have happened. Agents use it to check their work.
 *   idempotencyKey  a mutating call with the same key + same input runs at
 *                   most once per org; retries get the stored response.
 *                   Same key + different input → idempotency_conflict.
 */

export type ExecuteOptions = { dryRun?: boolean; idempotencyKey?: string };
export type ExecuteResult =
  | { ok: true; data: unknown; dryRun: boolean; replayed: boolean }
  | { ok: false; error: AppError };

class DryRunRollback extends Error {
  constructor(readonly data: unknown) {
    super("dry run");
  }
}

/** JSON-safe copy (Dates → ISO strings, Decimals → strings). */
function toJson(data: unknown): unknown {
  return data === undefined ? null : JSON.parse(JSON.stringify(data));
}

/** Stable hash of an input object, independent of key order. */
function hashInput(opName: string, input: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
          )
        : v;
  return createHash("sha256").update(`${opName}:${JSON.stringify(canonical(input))}`).digest("hex");
}

async function run(actor: Actor, op: Operation, input: unknown, dryRun: boolean): Promise<ExecuteResult> {
  try {
    if (dryRun) {
      try {
        await runAs(actor, async (ctx) => {
          throw new DryRunRollback(toJson(await op.run(ctx, input)));
        });
      } catch (err) {
        if (err instanceof DryRunRollback) {
          return { ok: true, data: err.data, dryRun: true, replayed: false };
        }
        throw err;
      }
    }
    const data = toJson(await runAs(actor, (ctx) => op.run(ctx, input)));
    return { ok: true, data, dryRun: false, replayed: false };
  } catch (err) {
    return { ok: false, error: toAppError(err) };
  }
}

export async function executeOperation(
  actor: Actor,
  op: Operation,
  input: unknown,
  opts: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const mutation = isMutation(op);
  const dryRun = Boolean(opts.dryRun) && mutation;
  const key = opts.idempotencyKey?.trim();
  if (!mutation || dryRun || !key) return run(actor, op, input, dryRun);

  if (key.length > 255) {
    return { ok: false, error: new AppError("invalid_input", "Idempotency key is too long (max 255).") };
  }
  const org = actor.organizationId;
  const requestHash = hashInput(op.name, input);

  // Keys live 24h. Clear a stale one so the key can be reused.
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.organizationId, org),
        eq(idempotencyKeys.key, key),
        sql`${idempotencyKeys.createdAt} < now() - interval '24 hours'`
      )
    );

  // Claim the key in its own committed statement so concurrent retries see it.
  const [claimed] = await db
    .insert(idempotencyKeys)
    .values({ organizationId: org, key, operation: op.name, requestHash })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  if (!claimed) {
    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.organizationId, org), eq(idempotencyKeys.key, key)));
    if (!existing || existing.requestHash !== requestHash || existing.operation !== op.name) {
      return {
        ok: false,
        error: new AppError(
          "idempotency_conflict",
          "This idempotency key was already used with a different request. Use a new key for a new request."
        ),
      };
    }
    if (!existing.completedAt) {
      return {
        ok: false,
        error: new AppError("conflict", "A request with this idempotency key is still in progress. Retry shortly."),
      };
    }
    const stored = existing.response as { ok: boolean; data?: unknown; error?: { code: AppError["code"]; message: string; details?: Record<string, unknown> } };
    if (stored.ok) return { ok: true, data: stored.data, dryRun: false, replayed: true };
    return {
      ok: false,
      error: new AppError(stored.error!.code, stored.error!.message, stored.error!.details),
    };
  }

  const result = await run(actor, op, input, false);
  if (!result.ok && result.error.code === "internal") {
    // Don't pin a crash to the key; let the client retry.
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, claimed.id));
    return result;
  }
  await db
    .update(idempotencyKeys)
    .set({
      statusCode: result.ok ? 200 : result.error.status,
      response: result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error.toJSON() },
      completedAt: sql`now()`,
    })
    .where(eq(idempotencyKeys.id, claimed.id));
  return result;
}

/** Cron housekeeping: drop idempotency keys older than 24 hours. */
export async function pruneIdempotencyKeys(): Promise<number> {
  const rows = await db
    .delete(idempotencyKeys)
    .where(sql`${idempotencyKeys.createdAt} < now() - interval '24 hours'`)
    .returning({ id: idempotencyKeys.id });
  return rows.length;
}
