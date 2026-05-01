import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { costCodes, jobs } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { ChangeOrderForm } from "../co-form";

export default async function NewChangeOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.organizationId, organization.id)));
  if (!job) notFound();
  if (job.status === "closed") notFound();

  const ccRows = await db
    .select({ id: costCodes.id, code: costCodes.code, name: costCodes.name })
    .from(costCodes)
    .where(
      and(
        eq(costCodes.organizationId, organization.id),
        eq(costCodes.isActive, true)
      )
    )
    .orderBy(asc(costCodes.code));

  return (
    <AppShell
      title={`New CO — ${job.code}`}
      crumb={`${organization.name} · Projects · Jobs · ${job.code} · Change Orders`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              New Change Order
            </div>
            <div className="text-sm mt-1 text-muted-foreground">
              {job.code} — {job.name}
            </div>
          </div>
          <Link
            href={`/jobs/${id}/change-orders`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to list
          </Link>
        </div>

        <div className="rounded-md border border-border p-5 bg-card">
          <ChangeOrderForm jobId={id} costCodes={ccRows} />
        </div>
      </div>
    </AppShell>
  );
}
