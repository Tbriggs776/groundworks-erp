import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getRecurringInvoice } from "@/lib/ar/recurring-invoices";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { DocLines, Notes } from "../../doc-view";
import { FREQUENCY_LABEL, TYPE_LABEL, TYPE_NOTE } from "../labels";
import { RecurringActions } from "./recurring-actions";

export default async function RecurringInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const t = await runAs(actor, (ctx) => getRecurringInvoice(ctx, { id })).catch((err) => {
    const code = toAppError(err).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw err;
  });
  const creator = await creatorOf(t);
  const fmt = (v: string) => formatMoney(v, { currency: t.currency });
  const scheduled = t.type !== "unscheduled";
  const ends = t.endDate ? `Ends ${t.endDate}` : t.maxOccurrences ? `Ends after ${t.maxOccurrences} invoices` : "No end date";

  return (
    <AppShell title={t.name} crumb={`${organization.name} · Sales · Recurring Invoices`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{t.name}</div>
            <div className="text-sm mt-1">{t.customerName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{TYPE_LABEL[t.type]}</span>
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
            <RecurringActions template={{ id: t.id, name: t.name, status: t.status, type: t.type }} />
            <Link href="/ar/recurring" className="text-xs text-muted-foreground hover:text-foreground">← Back to recurring invoices</Link>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Next invoice" value={scheduled && t.status === "active" ? (t.nextRunDate ?? "—") : "—"} />
          <Stat label="Created ahead" value={scheduled ? `${t.daysInAdvance} day(s)` : "—"} />
          <Stat label="Invoices made" value={String(t.occurrences)} />
          <Stat label="Last run" value={t.lastRunDate ?? "—"} />
        </div>
        <p className="text-xs text-muted-foreground">{TYPE_NOTE[t.type]}</p>

        {t.lastError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            <span className="font-semibold">Last run:</span> {t.lastError}
          </div>
        )}

        <DocLines
          lines={t.lines}
          subtotal={t.subtotalAmount}
          taxLines={[]}
          taxTotal={{ label: "Sales tax at today's rate", amount: t.taxAmount }}
          taxExempt={t.taxExempt}
          total={t.totalAmount}
          currency={t.currency}
        />

        {t.invoices.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Invoices from this template</div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {t.invoices.map((i) => (
                    <tr key={i.id} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/ar/invoices/${i.id}`} className="text-primary hover:underline">{i.invoiceNumber}</Link>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{i.invoiceDate}</td>
                      <td className="px-3 py-2"><StatusBadge status={i.status} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmt(i.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Notes memo={t.memo} privateNote={t.privateNote} />
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
