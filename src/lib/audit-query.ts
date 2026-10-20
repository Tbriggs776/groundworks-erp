import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { agents, auditLog, profiles } from "@/lib/db/schema";
import { requirePermission, type Ctx } from "@/lib/actor";
import { flag, id, pagination, toPage } from "@/lib/schemas";

/**
 * The audit trail, readable. Answers "what did the agents do today?" and
 * "who touched this invoice?" — for humans in the UI and for agents that
 * need to check their own work.
 */

export const ListActivitySchema = z.object({
  agentId: id.optional().describe("Only actions by this agent."),
  agentsOnly: flag.optional().describe("Only actions taken by agents."),
  entityId: id.optional().describe("Only events about this document / record."),
  since: z.iso.datetime({ offset: true }).optional().describe("ISO timestamp lower bound."),
  ...pagination,
});

/** The record an audit row is about, in words: its number or name when the metadata has one. */
export function auditRef(metadata: unknown): string | undefined {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const keys = [
    "invoiceNumber", "billNumber", "paymentNumber", "creditNumber", "memoNumber", "receiptNumber", "refundNumber",
    "estimateNumber", "poNumber", "txnNumber", "journalNumber", "number", "name", "email", "code", "report",
  ];
  for (const k of keys) if (typeof m[k] === "string" && m[k]) return m[k] as string;
  return undefined;
}

export async function listActivity(ctx: Ctx, input: z.input<typeof ListActivitySchema> = {}) {
  requirePermission(ctx.actor, "read", "viewer", "read the activity log");
  const f = ListActivitySchema.parse(input);
  const rows = await ctx.tx
    .select({
      id: auditLog.id,
      occurredAt: auditLog.occurredAt,
      event: auditLog.event,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      actorType: auditLog.actorType,
      channel: auditLog.channel,
      metadata: auditLog.metadata,
      userEmail: profiles.email,
      agentName: agents.name,
      agentId: auditLog.agentId,
    })
    .from(auditLog)
    .leftJoin(profiles, eq(profiles.id, auditLog.actorId))
    .leftJoin(agents, eq(agents.id, auditLog.agentId))
    .where(
      and(
        eq(auditLog.organizationId, ctx.actor.organizationId),
        f.agentId ? eq(auditLog.agentId, f.agentId) : undefined,
        f.agentsOnly ? eq(auditLog.actorType, "agent") : undefined,
        f.entityId ? eq(auditLog.entityId, f.entityId) : undefined,
        f.since ? gte(auditLog.occurredAt, new Date(f.since)) : undefined
      )
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows, f.limit, f.offset);
}
