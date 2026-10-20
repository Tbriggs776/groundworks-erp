import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listRecurringBills } from "@/lib/ap/recurring-bills";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { BILL_TYPE_LABEL, FREQUENCY_LABEL } from "./labels";

export default async function RecurringBillsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) => listRecurringBills(ctx, { limit: 200 }));

  return (
    <AppShell title="Recurring Bills" crumb={`${organization.name} · Expenses`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Bills that repeat. Scheduled ones are created and submitted for approval; reminders land in the review queue as drafts.
          </p>
          <Link
            href="/ap/recurring/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New recurring bill
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Template</th>
                <th className="text-left font-medium px-3 py-2">Vendor</th>
                <th className="text-left font-medium px-3 py-2 w-28">Type</th>
                <th className="text-left font-medium px-3 py-2 w-32">Repeats</th>
                <th className="text-left font-medium px-3 py-2 w-28">Next</th>
                <th className="text-right font-medium px-3 py-2 w-20">Made</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-xs text-muted-foreground">No recurring bills yet.</td>
                </tr>
              )}
              {page.data.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link href={`/ap/recurring/${t.id}`} className="text-primary hover:underline">{t.name}</Link>
                    {t.lastError && <div className="text-[11px] text-destructive">Last run had a problem</div>}
                  </td>
                  <td className="px-3 py-2">{t.vendorName}</td>
                  <td className="px-3 py-2 text-xs">{BILL_TYPE_LABEL[t.type]}</td>
                  <td className="px-3 py-2 text-xs">{t.type === "unscheduled" ? "—" : FREQUENCY_LABEL[t.frequency]}</td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{t.status === "active" ? (t.nextRunDate ?? "—") : "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{t.occurrences}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(t.totalAmount, { currency: t.currency })}</td>
                  <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
