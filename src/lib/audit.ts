import { db } from "@/lib/db/client";
import { auditLog, type NewAuditLogEntry } from "@/lib/db/schema";

/**
 * Emit a single audit log row. Callers should wrap this in the same
 * transaction as the mutating write they're recording — pass `tx` to keep
 * the entry and the state change atomic.
 *
 * Service code spreads `auditFields(ctx.actor)` (src/lib/actor.ts) into the
 * input so every row says who acted (user / agent / system), with which API
 * key, through which channel. Legacy callers that only pass `actorId` get
 * sensible defaults: a human via the UI, or the system when actorId is null.
 *
 * Event naming: dotted namespace. Examples:
 *   organization.created
 *   gl.journal.posted
 *   ap.bill.approved
 *   agent.key.created
 */
export type AuditInput = Omit<NewAuditLogEntry, "id" | "occurredAt">;

export async function writeAudit(
  input: AuditInput,
  tx: Pick<typeof db, "insert"> = db
): Promise<void> {
  await tx.insert(auditLog).values({
    ...input,
    actorType: input.actorType ?? (input.actorId ? "user" : "system"),
    channel: input.channel ?? (input.actorId ? "ui" : "system"),
  });
}
