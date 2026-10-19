import { AppShell } from "@/components/app-shell/shell";
import { hasWorkspaceRole, runAsWorkspace } from "@/lib/actor";
import { getCurrentOrg, getUser, requireWorkspace, requireWorkspaceActor } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import * as ws from "@/lib/workspace/service";
import { PeopleClient } from "./people-client";

/**
 * Everyone in the workspace and what they can open. One row per person,
 * one column per company; admins change roles inline and invite people
 * with access to several companies at once.
 */
export default async function PeoplePage() {
  const { workspace, role } = await requireWorkspace();
  const actor = await requireWorkspaceActor();
  const user = await getUser();
  const current = await getCurrentOrg();
  const isAdmin = hasWorkspaceRole(role, "admin");
  const [people, companies, invites] = await Promise.all([
    runAsWorkspace(actor, (ctx) => ws.listPeople(ctx)),
    runAsWorkspace(actor, (ctx) => ws.listCompanies(ctx)),
    isAdmin ? runAsWorkspace(actor, (ctx) => ws.listInvitations(ctx)) : Promise.resolve([]),
  ]);

  return (
    <AppShell title="People" crumb={`${workspace.name} · Workspace`} userEmail={user?.email}>
      <PeopleClient
        people={people}
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
        invites={invites}
        canManage={isAdmin}
        isOwner={role === "owner"}
        currentUserId={user?.id ?? ""}
        defaultCompanyId={current?.organizationId ?? companies[0]?.id ?? null}
        emailEnabled={emailConfigured()}
      />
    </AppShell>
  );
}
