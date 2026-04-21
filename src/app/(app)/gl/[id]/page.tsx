import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { accounts, fiscalPeriods, glJournals, glLines, sourceCodes } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, sumMoney } from "@/lib/money";

export default async function JournalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [journal] = await db
    .select({
      journal: glJournals,
      period: fiscalPeriods,
      sourceCode: sourceCodes,
    })
    .from(glJournals)
    .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, glJournals.periodId))
    .innerJoin(sourceCodes, eq(sourceCodes.id, glJournals.sourceCodeId))
    .where(
      and(
        eq(glJournals.id, id),
        eq(glJournals.organizationId, organization.id)
      )
    );

  if (!journal) notFound();

  const lines = await db
    .select({
      line: glLines,
      account: accounts,
    })
    .from(glLines)
    .innerJoin(accounts, eq(accounts.id, glLines.accountId))
    .where(eq(glLines.journalId, id))
    .orderBy(asc(glLines.lineNumber));

  const totalDebits = sumMoney(lines.map((r) => r.line.debit));
  const totalCredits = sumMoney(lines.map((r) => r.line.credit));

  const j = journal.journal;

  return (
    <AppShell
      title={`Journal ${j.journalNumber}`}
      crumb={`${organization.name} · General Ledger`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.1em] text-foreground">
              {j.journalNumber}
            </div>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3">
              <span>{j.journalDate}</span>
              <span>·</span>
              <span className="font-mono">{journal.period.periodCode}</span>
              <span>·</span>
              <span className="uppercase tracking-wider">
                {journal.sourceCode.code} / {j.source}
              </span>
              <span>·</span>
              <JournalStatusBadge status={j.status} />
            </div>
            <p className="mt-3 text-sm">{j.description}</p>
          </div>
          <Link
            href="/gl"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to list
          </Link>
        </div>

        {j.reversesJournalId && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            This journal reverses{" "}
            <Link
              href={`/gl/${j.reversesJournalId}`}
              className="text-primary hover:underline"
            >
              the original
            </Link>
            .
          </div>
        )}
        {j.reversedByJournalId && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            This journal was reversed by{" "}
            <Link
              href={`/gl/${j.reversedByJournalId}`}
              className="text-primary hover:underline"
            >
              a later entry
            </Link>
            .
          </div>
        )}
        {j.overrideHardClose && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider text-destructive">Hard-close override</span>
            {j.overrideReason && <> — {j.overrideReason}</>}
          </div>
        )}

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-12">#</th>
                <th className="text-left font-medium px-3 py-2">Account</th>
                <th className="text-left font-medium px-3 py-2">Memo</th>
                <th className="text-right font-medium px-3 py-2 w-36">Debit</th>
                <th className="text-right font-medium px-3 py-2 w-36">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ line, account }) => (
                <tr key={line.id} className="border-t border-border">
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                    {line.lineNumber}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs text-primary">
                      {account.code}
                    </span>
                    <span className="ml-2 text-sm">{account.name}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {line.memo}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {Number(line.debit) > 0 ? formatMoney(line.debit) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {Number(line.credit) > 0 ? formatMoney(line.credit) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/30 border-t-2 border-border">
                <td></td>
                <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground" colSpan={2}>
                  Totals
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(totalDebits)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(totalCredits)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="text-[11px] text-muted-foreground flex gap-4">
          <span>Currency: {j.currency}</span>
          <span>FX rate: {j.exchangeRate}</span>
          {j.postedAt && <span>Posted: {j.postedAt.toISOString().slice(0, 10)}</span>}
        </div>
      </div>
    </AppShell>
  );
}

function JournalStatusBadge({ status }: { status: string }) {
  const style: Record<string, "outline" | "secondary" | "destructive" | "default"> = {
    draft: "outline",
    pending_approval: "outline",
    posted: "default",
    reversed: "secondary",
  };
  return (
    <Badge variant={style[status] ?? "outline"} className="text-[9px]">
      {status}
    </Badge>
  );
}
