import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listInvitations, listMembers } from "@/lib/team/service";
import { TeamClient } from "./team-client";

export default async function TeamPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const isAdmin = hasRole(role, "admin");
  const [members, invites] = await Promise.all([
    runAs(actor, (ctx) => listMembers(ctx)),
    isAdmin ? runAs(actor, (ctx) => listInvitations(ctx)) : Promise.resolve([]),
  ]);

  return (
    <AppShell title="Team" crumb={`${organization.name} · Settings`} userEmail={user?.email}>
      <TeamClient
        members={members}
        invites={invites}
        canManage={isAdmin}
        isOwner={role === "owner"}
        currentUserId={user?.id ?? ""}
      />
    </AppShell>
  );
}
