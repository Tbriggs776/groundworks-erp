"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { switchOrganization, switchWorkspace } from "@/app/org-actions";

export type SwitcherWorkspace = {
  id: string;
  name: string;
  isAdmin: boolean;
  /** Opened through an owner's support grant (Groundworks staff only). */
  support?: boolean;
  companies: Array<{ id: string; name: string }>;
};

/**
 * One sign-in, every company: companies grouped by workspace. A workspace
 * where the person has no company yet opens its home page instead.
 */
export function OrgSwitcher({
  workspaces,
  currentOrgId,
  currentWorkspaceId,
}: {
  workspaces: SwitcherWorkspace[];
  currentOrgId: string | null;
  currentWorkspaceId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const current = currentOrgId ? `org:${currentOrgId}` : `ws:${currentWorkspaceId}`;
  const currentWs = workspaces.find((w) => w.id === currentWorkspaceId);
  const single = workspaces.length === 1;

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Building2 className="h-3.5 w-3.5 shrink-0" />
      <span className="sr-only">Company</span>
      <select
        value={current}
        disabled={pending}
        onChange={(e) => {
          const [kind, id] = e.target.value.split(":");
          if (kind === "all") router.push("/clients");
          else if (kind === "new-company") router.push("/workspace/companies/new");
          else if (kind === "new-workspace") router.push("/onboarding?new=1");
          else if (kind === "org") start(() => switchOrganization(id));
          else if (kind === "ws") start(() => switchWorkspace(id));
        }}
        className="max-w-[13rem] truncate bg-transparent border border-border rounded-md px-1.5 py-1 text-xs text-foreground"
      >
        {workspaces.map((w) => {
          const options = w.companies.length
            ? w.companies.map((c) => (
                <option key={c.id} value={`org:${c.id}`}>
                  {c.name}
                </option>
              ))
            : [
                <option key={w.id} value={`ws:${w.id}`}>
                  {w.name} (no companies)
                </option>,
              ];
          return single ? options : (
            <optgroup key={w.id} label={w.support ? `${w.name} (support access)` : w.name}>
              {options}
            </optgroup>
          );
        })}
        <option value="all:">All companies…</option>
        {currentWs?.isAdmin && <option value="new-company:">+ Add a company…</option>}
        <option value="new-workspace:">+ New workspace…</option>
      </select>
    </label>
  );
}
