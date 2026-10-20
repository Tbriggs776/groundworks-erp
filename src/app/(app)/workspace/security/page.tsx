import { AppShell } from "@/components/app-shell/shell";
import { hasWorkspaceRole, runAsWorkspace } from "@/lib/actor";
import { getUser, requireWorkspace, requireWorkspaceActor } from "@/lib/auth";
import * as ws from "@/lib/workspace/service";
import { PolicyForm } from "./policy-form";

/** The workspace security policy. Everyone can read it; admins change it. */
export default async function SecurityPolicyPage() {
  const { workspace, role } = await requireWorkspace();
  const actor = await requireWorkspaceActor();
  const user = await getUser();
  const [policy, people] = await Promise.all([
    runAsWorkspace(actor, (ctx) => ws.getSecurityPolicy(ctx)),
    runAsWorkspace(actor, (ctx) => ws.listPeople(ctx)),
  ]);
  const active = people.filter((p) => p.isActive);
  const withoutMfa = active.filter((p) => p.mfaEnabled === false);

  return (
    <AppShell title="Security" crumb={`${workspace.name} · Workspace`} userEmail={user?.email}>
      <div className="max-w-2xl space-y-6">
        <p className="text-sm text-muted-foreground">
          These rules apply to everyone in {workspace.name}. Someone in several workspaces gets the strictest rules
          across all of them.
        </p>
        {withoutMfa.length > 0 && (
          <div className="rounded-md border border-[var(--gw-amber-bright)]/25 bg-[var(--gw-amber)] p-3 text-xs text-[var(--gw-amber-bright)]">
            {withoutMfa.length} of {active.length} people haven&apos;t turned on two-step verification
            {policy.requireMfa ? "; they'll be asked to set it up on their next click." : "."}
          </div>
        )}
        <PolicyForm policy={policy} editable={hasWorkspaceRole(role, "admin")} />
      </div>
    </AppShell>
  );
}
