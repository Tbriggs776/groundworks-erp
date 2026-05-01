import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { commitments, jobs, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";
import { CommitmentStatusFilter } from "./filter";

const STATUS_STYLE: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "outline",
  issued: "default",
  closed: "secondary",
  voided: "outline",
};

const ALL_STATUSES = ["draft", "issued", "closed", "voided"] as const;

type SP = Promise<{ status?: string | string[] }>;

export default async function CommitmentsInboxPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const requested = Array.isArray(params.status)
    ? params.status
    : params.status
      ? [params.status]
      : null;
  const validStatuses = (ALL_STATUSES as readonly string[]).filter((s) =>
    requested ? requested.includes(s) : true
  );
  const defaultActionable = ["draft", "issued"];
  const activeFilter = requested === null ? defaultActionable : validStatuses;

  const rows = await db
    .select({
      c: commitments,
      job: jobs,
      vendor: vendors,
    })
    .from(commitments)
    .innerJoin(jobs, eq(jobs.id, commitments.jobId))
    .innerJoin(vendors, eq(vendors.id, commitments.vendorId))
    .where(
      and(
        eq(commitments.organizationId, organization.id),
        activeFilter.length > 0
          ? inArray(
              commitments.status,
              activeFilter as Array<"draft" | "issued" | "closed" | "voided">
            )
          : undefined
      )
    )
    .orderBy(desc(commitments.createdAt));

  return (
    <AppShell
      title="Commitments"
      crumb={`${organization.name} · Projects`}
      userEmail={user?.email}
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl tracking-[0.08em] text-foreground">
              COMMITMENTS
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Purchase orders + subcontracts. Issued commitments add to the
              Committed bucket on each job&apos;s budget; AP bills draw against
              them.
            </p>
          </div>
          <CommitmentStatusFilter activeFilter={activeFilter} />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rows.length} commitment{rows.length === 1 ? "" : "s"}.
          </div>
          <Link
            href="/commitments/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New commitment
          </Link>
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-32">Number</th>
                <th className="text-left font-medium px-3 py-2 w-20">Type</th>
                <th className="text-left font-medium px-3 py-2 w-28">Job</th>
                <th className="text-left font-medium px-3 py-2">Vendor</th>
                <th className="text-right font-medium px-3 py-2 w-32">Total</th>
                <th className="text-right font-medium px-3 py-2 w-32">
                  Invoiced
                </th>
                <th className="text-right font-medium px-3 py-2 w-32">
                  Remaining
                </th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No commitments match this filter.
                  </td>
                </tr>
              )}
              {rows.map(({ c, job, vendor }) => {
                const remaining = money(c.totalAmount).minus(
                  money(c.invoicedAmount)
                );
                return (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/commitments/${c.id}`}
                        className="text-primary hover:underline"
                      >
                        {c.commitmentNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {c.type === "subcontract" ? "Sub" : "PO"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/jobs/${job.id}`}
                        className="text-primary hover:underline"
                      >
                        {job.code}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{vendor.name}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatMoney(c.totalAmount, { currency: c.currency })}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {formatMoney(c.invoicedAmount, { currency: c.currency })}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        remaining.isNegative() ? "text-destructive" : ""
                      }`}
                    >
                      {formatMoney(remaining.toFixed(4), {
                        currency: c.currency,
                      })}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={STATUS_STYLE[c.status] ?? "outline"}
                        className="text-[9px] capitalize"
                      >
                        {c.status}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
