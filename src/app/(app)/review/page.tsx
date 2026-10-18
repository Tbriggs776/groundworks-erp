import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listReviewQueue } from "@/lib/review";
import { ReviewClient } from "./review-client";

export default async function ReviewPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const items = await runAs(actor, (ctx) => listReviewQueue(ctx));

  return (
    <AppShell title="Review Queue" crumb={`${organization.name} · Agents & API`} userEmail={user?.email}>
      <ReviewClient items={items} />
    </AppShell>
  );
}
