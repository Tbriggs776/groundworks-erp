import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { Button } from "@/components/ui/button";
import { getUserWorkspaces, requireUser } from "@/lib/auth";
import { isSupportStaff } from "@/lib/security/support";
import { switchWorkspace } from "@/app/org-actions";

/**
 * Groundworks support: workspaces whose owners have turned on support
 * access. Everyone else gets a 404. Opening one is read-only and lands in
 * that workspace's audit log.
 */
export default async function SupportPage() {
  const user = await requireUser();
  if (!isSupportStaff(user.id)) notFound();
  const granted = (await getUserWorkspaces()).filter((w) => w.support);

  return (
    <AppShell title="Support access" crumb="Groundworks support" userEmail={user.email}>
      <div className="max-w-3xl space-y-4">
        {user.aal !== "aal2" ? (
          <p className="rounded-md border border-border bg-card p-4 text-sm">
            Support access needs two-step verification in this session.{" "}
            <Link href="/account/security" className="underline underline-offset-2">Set it up</Link>, then sign out and
            back in.
          </p>
        ) : granted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspace has support access turned on right now.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {granted.map((w) => (
              <li key={w.workspaceId} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{w.workspace.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Read-only until{" "}
                    {w.support!.expiresAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC
                  </div>
                </div>
                <form action={switchWorkspace.bind(null, w.workspaceId)}>
                  <Button type="submit" size="sm">Open</Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Opening a workspace is recorded in its audit log, where the owner can see it.
        </p>
      </div>
    </AppShell>
  );
}
