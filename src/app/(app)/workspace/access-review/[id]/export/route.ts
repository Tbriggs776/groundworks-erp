import { runAsWorkspace } from "@/lib/actor";
import { requireWorkspaceActor } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/ui/csv";
import * as ws from "@/lib/workspace/service";

/** A completed access review as CSV: one row per access grant. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireWorkspaceActor("admin");
  const { id } = await params;
  const review = await runAsWorkspace(actor, (ctx) => ws.getAccessReview(ctx, { id }));
  const s = review.snapshot;
  const rows: unknown[][] = [
    ...s.people.flatMap((p) =>
      (p.companies.length ? p.companies : [{ company: "", role: "" }]).map((c) => [
        "person", p.email, p.name, p.workspaceRole, c.company, c.role, p.active ? "active" : "removed",
        p.mfa === null ? "unknown" : p.mfa ? "on" : "off", p.lastSeenAt, "", "",
      ])
    ),
    ...s.agents.map((a) => [
      "agent", a.name, "", "", a.company, a.role, a.active ? "active" : "inactive", "", a.lastActiveAt,
      `${a.autonomy}${a.maxPostAmount ? ` <= ${a.maxPostAmount}` : ""}`, "",
    ]),
    ...s.apiKeys.map((k) => [
      "api_key", `${k.name} (${k.prefix})`, k.owner, "", k.company, k.scopes.join(" "), "live", "", k.lastUsedAt, "", k.expiresAt ?? "never",
    ]),
  ];
  const day = new Date(review.completedAt).toISOString().slice(0, 10);
  return csvResponse(
    `access-review-${day}.csv`,
    toCsv(
      ["kind", "who", "detail", "workspace_role", "company", "role_or_scopes", "status", "mfa", "last_seen", "autonomy", "expires"],
      rows
    )
  );
}
