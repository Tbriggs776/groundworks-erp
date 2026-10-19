import { sql } from "drizzle-orm";
import {
  check,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, profiles, workspaces } from "./identity";

/**
 * Who performed an audited action:
 *   user   — a human (actor_id = profile)
 *   agent  — an AI agent (agent_id set; actor_id null)
 *   system — cron / background work (no actor)
 */
export const auditActorType = pgEnum("audit_actor_type", [
  "user",
  "agent",
  "system",
]);

/** Which surface the action arrived through. */
export const auditChannel = pgEnum("audit_channel", [
  "ui",
  "api",
  "mcp",
  "system",
]);

/**
 * AUDIT LOG — append-only, never updated. Every mutating action in the system
 * should emit an audit row. Critical for accounting correctness review and
 * for meeting SOC2 expectations — and for answering "which agent did this,
 * with which key, through which channel?"
 *
 * `event` uses dotted-namespace convention, e.g.
 *   organization.created, gl.journal.posted, ap.bill.approved
 *
 * `metadata` carries event-specific payload (before/after snapshots, amounts,
 * reference numbers). Keep PII out of metadata where possible.
 *
 * Company events carry `organization_id`; workspace events (people,
 * invitations, security policy, sign-ins) carry only `workspace_id`. A
 * BEFORE INSERT trigger fills `workspace_id` from the company, so callers
 * pass whichever they have.
 *
 * `agent_id` / `api_key_id` are plain UUIDs without FKs on purpose: the
 * append-only trigger rejects UPDATEs, so an ON DELETE SET NULL would make
 * the parent undeletable. Agents are deactivated and keys revoked instead.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for workspace-level events. */
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    /** Always set (trigger-filled from organization_id when omitted). */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    actorId: uuid("actor_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    /** Null only on rows written before actor attribution existed (0018);
     *  writeAudit always sets it. */
    actorType: auditActorType("actor_type"),
    agentId: uuid("agent_id"),
    apiKeyId: uuid("api_key_id"),
    channel: auditChannel("channel"),
    requestId: text("request_id"),
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
    index("audit_log_agent_idx").on(t.organizationId, t.agentId),
    index("audit_log_ws_time_idx").on(t.workspaceId, t.occurredAt),
    check("audit_log_workspace_required", sql`${t.workspaceId} IS NOT NULL`),
  ]
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
