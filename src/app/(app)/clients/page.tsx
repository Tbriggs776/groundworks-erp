import Link from "next/link";
import { Building2, Plus, Search } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { hasWorkspaceRole } from "@/lib/actor";
import { getCurrentOrg, getUserMemberships, getUserWorkspaces, requireUser } from "@/lib/auth";
import { switchOrganization, switchWorkspace } from "@/app/org-actions";

/**
 * Every workspace and company this person can open, on one page (like
 * QuickBooks' client list). Opening one makes it the active company; each
 * workspace's books stay separate.
 */
export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const [workspaces, companies, current, { q = "" }] = await Promise.all([
    getUserWorkspaces(),
    getUserMemberships(),
    getCurrentOrg(),
    searchParams,
  ]);
  const needle = q.trim().toLowerCase();
  const groups = workspaces
    .map((w) => {
      const all = companies.filter((c) => c.organization.workspaceId === w.workspaceId);
      const wsMatch = !needle || w.workspace.name.toLowerCase().includes(needle);
      return { w, list: wsMatch ? all : all.filter((c) => c.organization.name.toLowerCase().includes(needle)), wsMatch };
    })
    .filter((g) => g.wsMatch || g.list.length > 0);

  return (
    <AppShell
      title="All companies"
      crumb={`${companies.length} ${companies.length === 1 ? "company" : "companies"} · ${workspaces.length} ${workspaces.length === 1 ? "workspace" : "workspaces"}`}
      userEmail={user.email}
    >
      <div className="max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <form className="relative flex-1 min-w-56" action="/clients">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              name="q"
              defaultValue={q}
              placeholder="Find a company or workspace"
              className="w-full rounded-md border border-border bg-card py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </form>
          <Link href="/onboarding?new=1" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Plus className="h-3.5 w-3.5" /> New workspace
          </Link>
        </div>

        {groups.length === 0 && <p className="text-sm text-muted-foreground">Nothing matches &ldquo;{q}&rdquo;.</p>}

        {groups.map(({ w, list }) => (
          <section key={w.workspaceId} className="rounded-xl border border-border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-heading text-base tracking-[0.06em] truncate">{w.workspace.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {w.support
                    ? `Support access, read-only, until ${w.support.expiresAt.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}`
                    : `Workspace ${w.role}`}
                </div>
              </div>
              {!w.support && (
                <form action={switchWorkspace.bind(null, w.workspaceId)}>
                  <Button type="submit" variant="ghost" size="sm">Workspace home</Button>
                </form>
              )}
              {!w.support && hasWorkspaceRole(w.role, "admin") && (
                <Link href="/workspace/companies/new" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  <Plus className="h-3.5 w-3.5" /> Company
                </Link>
              )}
            </header>
            {list.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No companies you can open here yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {list.map((c) => {
                  const isCurrent = current?.organizationId === c.organizationId;
                  return (
                    <li key={c.organizationId} className="flex items-center gap-3 px-4 py-3">
                      <Building2 className="h-4 w-4 shrink-0 text-[var(--gw-gold)]" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{c.organization.name}</div>
                        <div className="text-[11px] text-muted-foreground capitalize">
                          {c.role} · {c.organization.baseCurrency}
                        </div>
                      </div>
                      {isCurrent ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Open now</span>
                      ) : (
                        <form action={switchOrganization.bind(null, c.organizationId)}>
                          <Button type="submit" size="sm">Open</Button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </AppShell>
  );
}
