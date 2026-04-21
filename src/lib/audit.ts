import { db } from "@/lib/db/client";
import { auditLog, type NewAuditLogEntry } from "@/lib/db/schema";

/**
 * Emit a single audit log row. Callers should wrap this in the same
 * transaction as the mutating write they're recording — pass `tx` to keep
 * the entry and the state change atomic.
 *
 * Event naming: dotted namespace. Examples:
 *   organization.created
 *   gl.journal.posted
 *   ap.bill.approved
 *   membership.role.changed
 */
export type AuditInput = Omit<NewAuditLogEntry, "id" | "occurredAt">;

export async function writeAudit(
  input: AuditInput,
  tx: Pick<typeof db, "insert"> = db
): Promise<void> {
  await tx.insert(auditLog).values(input);
}
