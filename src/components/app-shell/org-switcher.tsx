"use client";

import { useTransition } from "react";
import { Building2 } from "lucide-react";
import { switchOrganization } from "@/app/org-actions";

/**
 * Compact org switcher for people in more than one organization. The last
 * option jumps to onboarding to add a company.
 */
export function OrgSwitcher({
  current,
  orgs,
}: {
  current: string;
  orgs: Array<{ id: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Building2 className="h-3.5 w-3.5 shrink-0" />
      <span className="sr-only">Organization</span>
      <select
        value={current}
        disabled={pending}
        onChange={(e) => {
          const value = e.target.value;
          if (value === "__new") {
            window.location.href = "/onboarding?new=1";
            return;
          }
          start(() => switchOrganization(value));
        }}
        className="max-w-[11rem] truncate bg-transparent border border-border rounded-md px-1.5 py-1 text-xs text-foreground"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        <option value="__new">+ New organization…</option>
      </select>
    </label>
  );
}
