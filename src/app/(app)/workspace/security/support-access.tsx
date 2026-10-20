"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { allowSupportAccess, endSupportAccess } from "./actions";

const EVENTS: Record<string, string> = {
  "support_access.granted": "Turned on",
  "support_access.revoked": "Turned off",
  "support_access.opened": "Support opened the workspace",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/**
 * Groundworks support access: off unless the owner turns it on for a set
 * time. Read-only for support, and every visit shows up in the list.
 */
export function SupportAccess({
  active,
  canGrant,
  canRevoke,
  history,
}: {
  active: { expiresAt: string; grantedBy: string | null } | null;
  canGrant: boolean;
  canRevoke: boolean;
  history: Array<{ event: string; at: string; who: string | null }> | null;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setErr(null);
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Something went wrong.");
    });

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Groundworks support access</div>
        <p className="text-sm mt-1.5">
          {active ? (
            <>
              <span className="font-medium">On</span> until {when(active.expiresAt)}
              {active.grantedBy && <span className="text-muted-foreground">, turned on by {active.grantedBy}</span>}. Support
              can look at your books but can&apos;t change anything.
            </>
          ) : (
            <>
              <span className="font-medium">Off.</span> Nobody at Groundworks can see inside this workspace. If you need
              help, the owner can let support look (read-only) for a set time.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {canGrant &&
          [1, 3, 7].map((days) => (
            <Button key={days} size="sm" variant={active ? "outline" : "default"} disabled={pending} onClick={() => run(() => allowSupportAccess(days))}>
              {active ? "Extend" : "Allow"} for {days === 1 ? "1 day" : `${days} days`}
            </Button>
          ))}
        {active && canRevoke && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => endSupportAccess())}>
            Turn off now
          </Button>
        )}
        {!canGrant && !active && <p className="text-xs text-muted-foreground">Only a workspace owner can turn it on.</p>}
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {history && history.length > 0 && (
        <ul className="border-t border-border pt-3 space-y-1 text-xs">
          {history.map((h, i) => (
            <li key={i} className="flex flex-wrap gap-x-2 text-muted-foreground">
              <span className="text-foreground">{EVENTS[h.event] ?? h.event}</span>
              <span>{when(h.at)}</span>
              {h.who && <span>· {h.who}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
