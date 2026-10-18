import { runAsWorkspace, workspaceAuditFields } from "@/lib/actor";
import { requireWorkspaceActor } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { csvResponse, toCsv } from "@/lib/ui/csv";
import * as ws from "@/lib/workspace/service";

/** Audit log export for auditors. The export itself is audited. */
export async function GET(request: Request) {
  const actor = await requireWorkspaceActor("admin");
  const sp = new URL(request.url).searchParams;
  const query = {
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    event: sp.get("event") || undefined,
    organizationId: sp.get("company") || undefined,
    limit: 10000,
  };
  const rows = await runAsWorkspace(actor, async (ctx) => {
    const r = await ws.listWorkspaceAudit(ctx, query);
    await writeAudit(
      { ...workspaceAuditFields(ctx.actor), event: "workspace.audit_log.exported", metadata: { ...query, rows: r.length } },
      ctx.tx
    );
    return r;
  });
  const body = toCsv(
    ["occurred_at", "event", "company", "actor_type", "actor_email", "agent", "api_key_id", "channel", "entity_type", "entity_id", "ip_address", "user_agent", "request_id", "metadata"],
    rows.map((r) => [
      r.occurredAt, r.event, r.company, r.actorType, r.actorEmail, r.agentName, r.apiKeyId, r.channel,
      r.entityType, r.entityId, r.ipAddress, r.userAgent, r.requestId, r.metadata,
    ])
  );
  return csvResponse(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, body);
}
