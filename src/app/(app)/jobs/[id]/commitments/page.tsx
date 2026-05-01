import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { commitments, jobs, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";
import { getJobCommitmentsSummary } from "@/lib/projects/commitments";

const STATUS_STYLE: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "outline",
  issued: "default",
  closed: "secondary",
  voided: "outline",
};

export default async function JobCommitmentsPage({
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

  const [rows, summary] = await Promise.all([
    db
      .select({ c: commitments, vendor: vendors })
      .from(commitments)
      .innerJoin(vendors, eq(vendors.id, commitments.vendorId))
      .where(
        and(
          eq(commitments.organizationId, organization.id),
          eq(commitments.jobId, id)
        )
      )
      .orderBy(desc(commitments.createdAt)),
    getJobCommitmentsSummary(organization.id, id),
  ]);

  return (
    <AppShell
      title={`Commitments — ${job.code}`}
      crumb={`${organization.name} · Projects · Jobs · ${job.code}`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-6xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {job.code} — Commitments
            </div>
            <div className="text-sm mt-1 text-muted-foreground">{job.name}</div>
          </div>
          <Link
            href={`/jobs/${id}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to job
          </Link>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Tile label="Issued" value={String(summary.issuedCount)} />
          <Tile label="Total committed" money={summary.totalCommitted} accent />
          <Tile label="Invoiced" money={summary.totalInvoiced} muted />
          <Tile
            label="Remaining"
            money={summary.totalRemaining}
            warn={Number(summary.totalRemaining) < 0}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rows.length} commitment{rows.length === 1 ? "" : "s"} on this job.
          </div>
          {job.status !== "closed" && (
            <Link
              href={`/commitments/new?jobId=${id}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              New commitment
            </Link>
          )}
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-32">Number</th>
                <th className="text-left font-medium px-3 py-2 w-20">Type</th>
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
                    colSpan={7}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No commitments on this job yet.
                  </td>
                </tr>
              )}
              {rows.map(({ c, vendor }) => {
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

function Tile({
  label,
  value,
  money: amount,
  accent,
  muted,
  warn,
}: {
  label: string;
  value?: string;
  money?: string;
  accent?: boolean;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
        {label}
      </div>
      <div
        className={`font-mono text-lg ${
          warn
            ? "text-destructive"
            : accent
              ? "text-primary"
              : muted
                ? "text-muted-foreground"
                : "text-foreground"
        }`}
      >
        {amount !== undefined ? formatMoney(amount) : value}
      </div>
    </div>
  );
}
