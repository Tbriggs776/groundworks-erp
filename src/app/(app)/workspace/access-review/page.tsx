import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { runAsWorkspace } from "@/lib/actor";
import { getUser, requireWorkspace, requireWorkspaceActor } from "@/lib/auth";
import * as ws from "@/lib/workspace/service";
import { CompleteReview } from "./complete-review";
import { SnapshotView } from "./snapshot-view";

/**
 * Periodic access review (SOC 2 CC6.2 / CC6.3): an admin looks at who can
 * reach what, fixes anything stale, and signs off. Each sign-off freezes
 * the snapshot as evidence.
 */
export default async function AccessReviewPage() {
  const { workspace } = await requireWorkspace("admin");
  const actor = await requireWorkspaceActor("admin");
  const user = await getUser();
  const [snapshot, history] = await Promise.all([
    runAsWorkspace(actor, (ctx) => ws.accessSnapshot(ctx)),
    runAsWorkspace(actor, (ctx) => ws.listAccessReviews(ctx)),
  ]);
  const last = history[0];
  const daysSince = last ? Math.floor((new Date(snapshot.takenAt).getTime() - new Date(last.completedAt).getTime()) / 86_400_000) : null;

  return (
    <AppShell title="Access review" crumb={`${workspace.name} · Workspace`} userEmail={user?.email}>
      <div className="space-y-8 max-w-6xl">
        <div className="rounded-md border border-border p-4 space-y-3">
          <p className="text-sm">
            {last
              ? `Last reviewed ${daysSince === 0 ? "today" : `${daysSince} days ago`} by ${last.reviewerEmail ?? "a former member"}.`
              : "No access review on record yet."}{" "}
            <span className="text-muted-foreground">Review at least every quarter: remove people who left, lower roles that are broader than needed, revoke unused keys.</span>
          </p>
          <CompleteReview />
        </div>

        <SnapshotView snapshot={snapshot} />

        {history.length > 0 && (
          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Past reviews</div>
            <ul className="divide-y divide-border rounded-md border border-border text-sm">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                  <Link href={`/workspace/access-review/${h.id}`} className="text-primary hover:underline">
                    {new Date(h.completedAt).toLocaleString()}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {h.reviewerEmail ?? "Former member"} · {h.people} people · {h.agents} agents · {h.apiKeys} keys
                  </span>
                  {h.notes && <span className="text-xs w-full text-muted-foreground">{h.notes}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </AppShell>
  );
}
