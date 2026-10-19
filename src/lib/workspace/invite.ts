import { eq } from "drizzle-orm";
import { runAsWorkspace, type WorkspaceActor } from "@/lib/actor";
import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";
import { invitationEmail, sendEmail } from "@/lib/email";
import { createInvitation, type InviteInput } from "./service";

export type InviteOutcome = {
  email: string;
  link: string;
  /** False when email isn't configured or failed: share the link instead. */
  emailed: boolean;
  note?: string;
};

/**
 * Create (or refresh) an invitation, then email it once the transaction
 * has committed. The link is always returned so the inviter can copy it.
 */
export async function inviteAndEmail(actor: WorkspaceActor, input: InviteInput, origin: string): Promise<InviteOutcome> {
  const r = await runAsWorkspace(actor, (ctx) => createInvitation(ctx, input));
  const link = `${origin}/invite/${r.token}`;
  const [inviter] = await db
    .select({ email: profiles.email, name: profiles.fullName })
    .from(profiles)
    .where(eq(profiles.id, actor.userId));
  const sent = await sendEmail(
    invitationEmail({
      to: r.invitation.email,
      inviter: inviter?.name || inviter?.email || "A teammate",
      workspaceName: r.workspaceName,
      companyNames: r.companyNames,
      link,
    })
  );
  return { email: r.invitation.email, link, emailed: sent.sent, note: sent.sent ? undefined : sent.reason };
}
