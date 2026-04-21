import { index, inet, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations, profiles } from "./identity";

/**
 * AUDIT LOG — append-only, never updated. Every mutating action in the system
 * should emit an audit row. Critical for accounting correctness review and
 * for meeting DCAA / SOC2 expectations.
 *
 * `event` uses dotted-namespace convention, e.g.
 *   organization.created, gl.journal.posted, ap.bill.approved
 *
 * `metadata` carries event-specific payload (before/after snapshots, amounts,
 * reference numbers). Keep PII out of metadata where possible.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    event: text("event").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_org_time_idx").on(t.organizationId, t.occurredAt),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_event_idx").on(t.event),
  ]
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
