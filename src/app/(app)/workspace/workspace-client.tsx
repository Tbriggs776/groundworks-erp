"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { switchOrganization } from "@/app/org-actions";
import { joinCompany, renameWorkspace } from "./actions";

export function WorkspaceName({ name, editable }: { name: string; editable: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <h2 className="font-heading text-2xl tracking-[0.1em]">{name}</h2>
        {editable && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Rename
          </Button>
        )}
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await renameWorkspace(value);
          if (!r.ok) setErr(r.error);
          else {
            setEditing(false);
            router.refresh();
          }
        });
      }}
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} className="max-w-xs" aria-label="Workspace name" />
      <Button type="submit" size="sm" disabled={pending}>Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      {err && <p className="w-full text-xs text-destructive">{err}</p>}
    </form>
  );
}

export function CompanyCardActions({
  organizationId,
  hasAccess,
  canJoin,
}: {
  organizationId: string;
  hasAccess: boolean;
  canJoin: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  if (hasAccess) {
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(() => switchOrganization(organizationId))}>
        Open books
      </Button>
    );
  }
  if (!canJoin) return null;
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await joinCompany(organizationId);
            if (!r.ok) setErr(r.error);
            else router.refresh();
          })
        }
      >
        Give myself access
      </Button>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
