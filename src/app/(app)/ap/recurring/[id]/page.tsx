import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getRecurringBill } from "@/lib/ap/recurring-bills";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { toAppError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { BILL_TYPE_LABEL, BILL_TYPE_NOTE, FREQUENCY_LABEL } from "../labels";
import { RecurringBillActions } from "./recurring-bill-actions";

export default async function RecurringBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const t = await runAs(actor, (ctx) => getRecurringBill(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  const creator = await creatorOf(t);
  const accountRows = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organization.id), inArray(accounts.id, t.lines.map((l) => l.accountId))));
  const accountById = new Map(accountRows.map((a) => [a.id, a]));
  const fmt = (v: string) => formatMoney(v, { currency: t.currency });
  const scheduled = t.type !== "unscheduled";
  const ends = t.endDate ? `Ends ${t.endDate}` : t.maxOccurrences ? `Ends after ${t.maxOccurrences} bills` : "No end date";

  return (
    <AppShell title={t.name} crumb={`${organization.name} · Expenses · Recurring Bills`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{t.name}</div>
            <div className="text-sm mt-1">{t.vendorName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{BILL_TYPE_LABEL[t.type]}</span>
              {scheduled && (
                <>
                  <span>·</span>
                  <span>{FREQUENCY_LABEL[t.frequency]}</span>
                  <span>·</span>
                  <span>{ends}</span>
                </>
              )}
              <StatusBadge status={t.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <RecurringBillActions template={{ id: t.id, name: t.name, status: t.status, type: t.type }} />
            <Link href="/ap/recurring" className="text-xs text-muted-foreground hover:text-foreground">← Back to recurring bills</Link>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Next bill" value={scheduled && t.status === "active" ? (t.nextRunDate ?? "—") : "—"} />
          <Stat label="Created ahead" value={scheduled ? `${t.daysInAdvance} day(s)` : "—"} />
          <Stat label="Bills made" value={String(t.occurrences)} />
          <Stat label="Last run" value={t.lastRunDate ?? "—"} />
        </div>
        <p className="text-xs text-muted-foreground">{BILL_TYPE_NOTE[t.type]}</p>

        {t.lastError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            <span className="font-semibold">Last run:</span> {t.lastError}
          </div>
        )}

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-10">#</th>
                <th className="text-left font-medium px-3 py-2">Account</th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {t.lines.map((l) => {
                const a = accountById.get(l.accountId);
                return (
                  <tr key={l.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.lineNumber}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="font-mono text-muted-foreground">{a?.code}</span> {a?.name}
                    </td>
                    <td className="px-3 py-2 text-xs">{l.description}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/30">
              <tr className="border-t-2 border-border">
                <td colSpan={3} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Each bill</td>
                <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{fmt(t.totalAmount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {t.bills.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Bills from this template</div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {t.bills.map((b) => (
                    <tr key={b.id} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/ap/bills/${b.id}`} className="text-primary hover:underline">{b.billNumber}</Link>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{b.billDate}</td>
                      <td className="px-3 py-2"><StatusBadge status={b.status} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmt(b.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {t.notes && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{t.notes}</p>}
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-mono mt-0.5">{value}</div>
    </div>
  );
}
