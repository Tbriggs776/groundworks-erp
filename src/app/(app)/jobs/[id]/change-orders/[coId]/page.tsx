import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import {
  changeOrders,
  costCodes,
  jobs,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { getChangeOrderLinesWithCostCodes } from "@/lib/projects/change-orders";
import { ChangeOrderForm } from "../co-form";
import { ChangeOrderActions } from "./actions-client";

const STATUS_STYLE: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "outline",
  pending_approval: "secondary",
  rejected: "destructive",
  approved: "secondary",
  executed: "default",
  voided: "outline",
};

export default async function ChangeOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string; coId: string }>;
}) {
  const { id, coId } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [result] = await db
    .select({ co: changeOrders, job: jobs })
    .from(changeOrders)
    .innerJoin(jobs, eq(jobs.id, changeOrders.jobId))
    .where(
      and(
        eq(changeOrders.id, coId),
        eq(changeOrders.organizationId, organization.id),
        eq(changeOrders.jobId, id)
      )
    );
  if (!result) notFound();

  const { co, job } = result;

  const linesWithCC = await getChangeOrderLinesWithCostCodes(co.id);

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

  const adj = Number(co.contractAdjustment);
  const isDraft = co.status === "draft";

  return (
    <AppShell
      title={`${co.coNumber} — ${job.code}`}
      crumb={`${organization.name} · Projects · Jobs · ${job.code} · Change Orders`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {co.coNumber}
            </div>
            <div className="text-sm mt-1">{co.description}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-3">
              <span>
                Job:{" "}
                <Link
                  href={`/jobs/${id}`}
                  className="text-primary hover:underline"
                >
                  {job.code} {job.name}
                </Link>
              </span>
              {co.externalReference && (
                <>
                  <span>·</span>
                  <span>
                    Ext ref:{" "}
                    <span className="font-mono text-foreground">
                      {co.externalReference}
                    </span>
                  </span>
                </>
              )}
              {co.effectiveDate && (
                <>
                  <span>·</span>
                  <span>Effective {co.effectiveDate}</span>
                </>
              )}
              <span>·</span>
              <Badge
                variant={STATUS_STYLE[co.status] ?? "outline"}
                className="text-[9px] capitalize"
              >
                {co.status.replace(/_/g, " ")}
              </Badge>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <ChangeOrderActions
              jobId={id}
              changeOrderId={co.id}
              status={co.status}
              hasLines={linesWithCC.length > 0}
            />
            <Link
              href={`/jobs/${id}/change-orders`}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back to list
            </Link>
          </div>
        </div>

        {co.status === "rejected" && co.rejectionReason && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold text-destructive">
              Rejected
            </span>
            {" — "}
            {co.rejectionReason}
            <span className="ml-2 text-muted-foreground">
              Reopen to make changes and re-submit.
            </span>
          </div>
        )}

        {co.status === "voided" && co.voidReason && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">
              Voided
            </span>{" "}
            — {co.voidReason}
          </div>
        )}

        {/* Header summary tiles */}
        <div className="grid grid-cols-3 gap-3">
          <Tile
            label="Contract adjustment"
            money={co.contractAdjustment}
            warn={adj < 0}
            accent={adj > 0}
          />
          <Tile
            label="Schedule Δ (days)"
            value={String(co.scheduleAdjustmentDays)}
          />
          <Tile
            label="Lines total"
            money={linesWithCC
              .reduce((acc, { line }) => acc + Number(line.amount), 0)
              .toFixed(4)}
          />
        </div>

        {/* Lines table (always read-only here — editing happens via the
            draft form below) */}
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-32">Code</th>
                <th className="text-left font-medium px-3 py-2">Cost code</th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-36">
                  Amount Δ
                </th>
              </tr>
            </thead>
            <tbody>
              {linesWithCC.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    No lines yet.
                  </td>
                </tr>
              )}
              {linesWithCC.map(({ line, costCode }) => {
                const a = Number(line.amount);
                return (
                  <tr key={line.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      {costCode.code}
                    </td>
                    <td className="px-3 py-2 text-xs">{costCode.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {line.description ?? "—"}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        a < 0 ? "text-destructive" : ""
                      }`}
                    >
                      {formatMoney(line.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {co.notes && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-1 font-semibold">
              Notes
            </div>
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {co.notes}
            </div>
          </div>
        )}

        {/* Inline edit when the CO is a draft */}
        {isDraft && (
          <div className="rounded-md border border-border p-5 bg-card">
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-3 font-semibold">
              Edit draft
            </div>
            <ChangeOrderForm
              jobId={id}
              changeOrderId={co.id}
              costCodes={ccRows}
              initial={{
                description: co.description,
                externalReference: co.externalReference,
                contractAdjustment: co.contractAdjustment,
                scheduleAdjustmentDays: co.scheduleAdjustmentDays,
                effectiveDate: co.effectiveDate,
                notes: co.notes,
                lines: linesWithCC.map(({ line }) => ({
                  costCodeId: line.costCodeId,
                  amount: line.amount,
                  description: line.description,
                })),
              }}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Tile({
  label,
  value,
  money,
  accent,
  warn,
}: {
  label: string;
  value?: string;
  money?: string;
  accent?: boolean;
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
              : "text-foreground"
        }`}
      >
        {money !== undefined ? formatMoney(money) : value}
      </div>
    </div>
  );
}
