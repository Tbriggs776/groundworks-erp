import Link from "next/link";
import { AppShell } from "@/components/app-shell/shell";
import { buttonVariants } from "@/components/ui/button";
import { runAsWorkspace } from "@/lib/actor";
import { getUser, requireWorkspace, requireWorkspaceActor } from "@/lib/auth";
import * as ws from "@/lib/workspace/service";
import { SnapshotView } from "../snapshot-view";

/** One completed review, exactly as it was signed off. */
export default async function AccessReviewDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspace } = await requireWorkspace("admin");
  const actor = await requireWorkspaceActor("admin");
  const user = await getUser();
  const review = await runAsWorkspace(actor, (ctx) => ws.getAccessReview(ctx, { id }));
  return (
    <AppShell title="Access review" crumb={`${workspace.name} · ${new Date(review.completedAt).toLocaleDateString()}`} userEmail={user?.email}>
      <div className="space-y-6 max-w-6xl">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link href="/workspace/access-review" className="text-muted-foreground hover:text-foreground">← Access review</Link>
          <span>Signed off {new Date(review.completedAt).toLocaleString()}</span>
          <a
            href={`/workspace/access-review/${review.id}/export`}
            download
            className={buttonVariants({ size: "sm", variant: "outline", className: "ml-auto" })}
          >
            Download CSV
          </a>
        </div>
        {review.notes && <p className="text-sm rounded-md border border-border p-3">{review.notes}</p>}
        <SnapshotView snapshot={review.snapshot} />
      </div>
    </AppShell>
  );
}
