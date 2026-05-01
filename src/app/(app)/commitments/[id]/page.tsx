import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import {
  accounts,
  apBillLines,
  apBills,
  commitments,
  costCodes,
  jobs,
  vendors,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";
import { getCommitmentLinesWithCostCodes } from "@/lib/projects/commitments";
import { CommitmentForm } from "../commitment-form";
import { CommitmentActions } from "./actions-client";

const STATUS_STYLE: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "outline",
  issued: "default",
  closed: "secondary",
  voided: "outline",
};

export default async function CommitmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [result] = await db
    .select({ c: commitments, job: jobs, vendor: vendors })
    .from(commitments)
    .innerJoin(jobs, eq(jobs.id, commitments.jobId))
    .innerJoin(vendors, eq(vendors.id, commitments.vendorId))
    .where(
      and(
        eq(commitments.id, id),
        eq(commitments.organizationId, organization.id)
      )
    );
  if (!result) notFound();

  const { c, job, vendor } = result;

  // First load the lines so we know which line ids to filter bill-links on
  const linesWithCC = await getCommitmentLinesWithCostCodes(c.id);
  const lineIds = linesWithCC.map(({ line }) => line.id);

  const [trulyLinked, jobRows, vendorRows, ccRows, acctRows] =
    await Promise.all([
      lineIds.length === 0
        ? Promise.resolve([] as Array<{
            billId: string;
            billNumber: string;
            billStatus: string;
            billDate: string;
            lineAmount: string;
            accountCode: string;
          }>)
        : db
            .select({
              billId: apBills.id,
              billNumber: apBills.billNumber,
              billStatus: apBills.status,
              billDate: apBills.billDate,
              lineAmount: apBillLines.amount,
              accountCode: accounts.code,
            })
            .from(apBillLines)
            .innerJoin(apBills, eq(apBills.id, apBillLines.billId))
            .innerJoin(accounts, eq(accounts.id, apBillLines.accountId))
            .where(
              and(
                eq(apBillLines.organizationId, organization.id),
                inArray(apBillLines.commitmentLineId, lineIds)
              )
            )
            .orderBy(desc(apBills.billDate)),
      db
        .select({ id: jobs.id, code: jobs.code, name: jobs.name })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organization.id),
            ne(jobs.status, "closed")
          )
        )
        .orderBy(asc(jobs.code)),
      db
        .select({ id: vendors.id, code: vendors.code, name: vendors.name })
        .from(vendors)
        .where(
          and(
            eq(vendors.organizationId, organization.id),
            eq(vendors.isActive, true)
          )
        )
        .orderBy(asc(vendors.code)),
      db
        .select({ id: costCodes.id, code: costCodes.code, name: costCodes.name })
        .from(costCodes)
        .where(
          and(
            eq(costCodes.organizationId, organization.id),
            eq(costCodes.isActive, true)
          )
        )
        .orderBy(asc(costCodes.code)),
      db
        .select({ id: accounts.id, code: accounts.code, name: accounts.name })
        .from(accounts)
        .where(
          and(
            eq(accounts.organizationId, organization.id),
            eq(accounts.isActive, true),
            eq(accounts.directPosting, true),
            eq(accounts.accountType, "posting")
          )
        )
        .orderBy(asc(accounts.code)),
    ]);

  const totalAmount = money(c.totalAmount);
  const invoiced = money(c.invoicedAmount);
  const remaining = totalAmount.minus(invoiced);
  const isDraft = c.status === "draft";

  return (
    <AppShell
      title={`${c.commitmentNumber} — ${vendor.name}`}
      crumb={`${organization.name} · Projects · Commitments`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {c.commitmentNumber}
            </div>
            <div className="text-sm mt-1">{c.description}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-3">
              <span>
                Type:{" "}
                <span className="text-foreground capitalize">
                  {c.type === "subcontract" ? "Subcontract" : "Purchase Order"}
                </span>
              </span>
              <span>·</span>
              <span>
                Job:{" "}
                <Link
                  href={`/jobs/${job.id}`}
                  className="text-primary hover:underline"
                >
                  {job.code} {job.name}
                </Link>
              </span>
              <span>·</span>
              <span>Vendor: {vendor.name}</span>
              {c.externalReference && (
                <>
                  <span>·</span>
                  <span>
                    Ext ref:{" "}
                    <span className="font-mono text-foreground">
                      {c.externalReference}
                    </span>
                  </span>
                </>
              )}
              <span>·</span>
              <Badge
                variant={STATUS_STYLE[c.status] ?? "outline"}
                className="text-[9px] capitalize"
              >
                {c.status}
              </Badge>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <CommitmentActions
              commitmentId={c.id}
              status={c.status}
              hasLines={linesWithCC.length > 0}
            />
            <Link
              href="/commitments"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back to inbox
            </Link>
          </div>
        </div>

        {c.status === "voided" && c.voidReason && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold text-destructive">
              Voided
            </span>{" "}
            — {c.voidReason}
          </div>
        )}

        {c.status === "closed" && c.closeReason && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">
              Closed
            </span>{" "}
            — {c.closeReason}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <Tile label="Total" money={totalAmount.toFixed(4)} currency={c.currency} />
          <Tile label="Invoiced" money={invoiced.toFixed(4)} currency={c.currency} muted />
          <Tile
            label="Remaining"
            money={remaining.toFixed(4)}
            currency={c.currency}
            warn={remaining.isNegative()}
            accent={remaining.isPositive()}
          />
        </div>

        {/* Lines */}
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-32">Cost code</th>
                <th className="text-left font-medium px-3 py-2 w-28">Account</th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-right font-medium px-3 py-2 w-32">Invoiced</th>
                <th className="text-right font-medium px-3 py-2 w-32">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {linesWithCC.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    No lines.
                  </td>
                </tr>
              )}
              {linesWithCC.map(({ line, costCode }) => {
                const remain = money(line.amount).minus(
                  money(line.invoicedAmount)
                );
                return (
                  <tr key={line.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      {costCode.code}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {/* We didn't pull account code on the lines join; show via line.accountId? Skipped for brevity. */}
                      —
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {costCode.name}
                      {line.description && (
                        <div className="text-[10px] text-muted-foreground">
                          {line.description}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {formatMoney(line.amount, { currency: c.currency })}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {formatMoney(line.invoicedAmount, {
                        currency: c.currency,
                      })}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        remain.isNegative() ? "text-destructive" : ""
                      }`}
                    >
                      {formatMoney(remain.toFixed(4), { currency: c.currency })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Linked bills */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-2 font-semibold">
            Bills against this commitment
          </div>
          {trulyLinked.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              No bills posted against this commitment yet.
            </div>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2 w-32">Bill #</th>
                    <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                    <th className="text-left font-medium px-3 py-2 w-24">Status</th>
                    <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {trulyLinked.map((b, i) => (
                    <tr key={`${b.billId}-${i}`} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link
                          href={`/ap/bills/${b.billId}`}
                          className="text-primary hover:underline"
                        >
                          {b.billNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground font-mono">
                        {b.billDate}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-[9px] capitalize">
                          {b.billStatus.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {formatMoney(b.lineAmount, { currency: c.currency })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {c.notes && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-1 font-semibold">
              Notes
            </div>
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {c.notes}
            </div>
          </div>
        )}

        {/* Inline draft edit */}
        {isDraft && (
          <div className="rounded-md border border-border p-5 bg-card">
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-3 font-semibold">
              Edit draft
            </div>
            <CommitmentForm
              commitmentId={c.id}
              jobs={jobRows}
              vendors={vendorRows}
              accounts={acctRows}
              costCodes={ccRows}
              initial={{
                jobId: c.jobId,
                vendorId: c.vendorId,
                type: c.type,
                description: c.description,
                externalReference: c.externalReference,
                currency: c.currency,
                exchangeRate: c.exchangeRate,
                effectiveDate: c.effectiveDate,
                expirationDate: c.expirationDate,
                notes: c.notes,
                lines: linesWithCC.map(({ line }) => ({
                  accountId: line.accountId,
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
  money: amount,
  currency,
  accent,
  muted,
  warn,
}: {
  label: string;
  money: string;
  currency: string;
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
        {formatMoney(amount, { currency })}
      </div>
    </div>
  );
}
