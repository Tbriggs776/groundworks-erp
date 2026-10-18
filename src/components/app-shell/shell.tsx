import { hasWorkspaceRole } from "@/lib/actor";
import { getCurrentOrg, getCurrentWorkspace, getUserMemberships, getUserWorkspaces } from "@/lib/auth";
import { KeepAlive } from "./keep-alive";
import type { SwitcherWorkspace } from "./org-switcher";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

type Props = {
  title: string;
  crumb?: string;
  userEmail?: string | null;
  children: React.ReactNode;
};

/**
 * Wraps every authenticated page in the standard shell. Pages provide their
 * own title + crumb; the shell handles nav + topbar. Below `md` the sidebar
 * collapses into a drawer opened from the topbar.
 */
export async function AppShell({ title, crumb, userEmail, children }: Props) {
  // Request-cached, so this costs nothing beyond what the page already did.
  const [workspaces, memberships, currentOrg, currentWs] = await Promise.all([
    getUserWorkspaces(),
    getUserMemberships(),
    getCurrentOrg(),
    getCurrentWorkspace(),
  ]);
  const switcher = {
    workspaces: workspaces.map(
      (w): SwitcherWorkspace => ({
        id: w.workspaceId,
        name: w.workspace.name,
        isAdmin: hasWorkspaceRole(w.role, "admin"),
        companies: memberships
          .filter((m) => m.organization.workspaceId === w.workspaceId)
          .map((m) => ({ id: m.organizationId, name: m.organization.name })),
      })
    ),
    currentOrgId: currentOrg?.organizationId ?? null,
    currentWorkspaceId: currentWs?.workspaceId ?? null,
  };
  const workspaceAdmin = Boolean(currentWs && hasWorkspaceRole(currentWs.role, "admin"));

  return (
    <div className="flex h-dvh overflow-hidden">
      <KeepAlive />
      <Sidebar workspaceAdmin={workspaceAdmin} />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <Topbar title={title} crumb={crumb} userEmail={userEmail} switcher={workspaces.length ? switcher : undefined} workspaceAdmin={workspaceAdmin} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
