import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { buttonVariants } from "@/components/ui/button";
import { hasWorkspaceRole, runAsWorkspace } from "@/lib/actor";
import { getUser, requireWorkspace, requireWorkspaceActor } from "@/lib/auth";
import * as ws from "@/lib/workspace/service";
import { CompanyCardActions, WorkspaceName } from "./workspace-client";

/** Workspace home: the companies in it, and where to manage the rest. */
export default async function WorkspacePage() {
  const { workspace, role } = await requireWorkspace();
  const actor = await requireWorkspaceActor();
  const user = await getUser();
  const isAdmin = hasWorkspaceRole(role, "admin");
  const [companies, policy] = await Promise.all([
    runAsWorkspace(actor, (ctx) => ws.listCompanies(ctx)),
    runAsWorkspace(actor, (ctx) => ws.getSecurityPolicy(ctx)),
  ]);

  return (
    <AppShell title="Workspace" crumb={workspace.name} userEmail={user?.email}>
      <div className="space-y-8 max-w-5xl">
        <WorkspaceName name={workspace.name} editable={isAdmin} />

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Companies</div>
            {isAdmin && (
              <Link href="/workspace/companies/new" className={buttonVariants({ size: "sm" })}>
                <Plus className="h-3.5 w-3.5" /> Add company
              </Link>
            )}
          </div>
          {companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isAdmin
                ? "No companies yet. Add one to start keeping books."
                : "You haven't been given access to any company in this workspace yet. Ask a workspace admin."}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {companies.map((c) => (
                <div key={c.id} className="rounded-lg border border-border bg-card p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <Building2 className="h-4 w-4 mt-0.5 text-[var(--gw-gold)]" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {c.baseCurrency} · {c.people} {c.people === 1 ? "person" : "people"}
                        {c.myRole ? ` · you: ${c.myRole}` : " · no access"}
                      </div>
                    </div>
                  </div>
                  <CompanyCardActions organizationId={c.id} hasAccess={Boolean(c.myRole)} canJoin={isAdmin} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          {[
            { href: "/workspace/people", title: "People", body: "Invite people and choose which companies they can open." },
            {
              href: "/workspace/security",
              title: "Security",
              body: `${policy.requireMfa ? "Two-step verification required" : "Two-step verification optional"} · idle sign-out after ${policy.sessionIdleMinutes} min`,
            },
            ...(isAdmin
              ? [
                  { href: "/workspace/access-review", title: "Access review", body: "Confirm who has access to what, and keep the record." },
                  { href: "/workspace/audit", title: "Audit log", body: "Every sign-in and change across the workspace, exportable." },
                ]
              : []),
          ].map((x) => (
            <Link key={x.href} href={x.href} className="rounded-lg border border-border p-4 hover:bg-accent transition-colors">
              <div className="font-medium">{x.title}</div>
              <div className="text-xs text-muted-foreground mt-1">{x.body}</div>
            </Link>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
