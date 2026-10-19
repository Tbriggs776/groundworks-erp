"use server";

import { requireCurrentOrg, requireWorkspaceActor } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { appOrigin } from "@/lib/ui/origin";
import { inviteAndEmail, type InviteOutcome } from "@/lib/workspace/invite";

export type TeamInviteRow = { email: string; access: "admin" | "accountant" | "bookkeeper" | "viewer" };
export type TeamInviteResult = InviteOutcome | { email: string; error: string };

/**
 * Sign-up step 2: invite teammates to the new company. "admin" also makes
 * them a workspace admin (they can manage people and companies); the rest
 * join as workspace members with that role in this company.
 */
export async function inviteTeam(rows: TeamInviteRow[]): Promise<TeamInviteResult[]> {
  const actor = await requireWorkspaceActor("admin");
  const company = await requireCurrentOrg();
  const origin = await appOrigin();
  const out: TeamInviteResult[] = [];
  for (const row of rows.filter((r) => r.email.trim()).slice(0, 20)) {
    try {
      out.push(
        await inviteAndEmail(
          actor,
          {
            email: row.email,
            workspaceRole: row.access === "admin" ? "admin" : "member",
            grants: [{ organizationId: company.organizationId, role: row.access }],
          },
          origin
        )
      );
    } catch (err) {
      out.push({ email: row.email, error: toAppError(err).message });
    }
  }
  return out;
}
