import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listRefunds } from "@/lib/ar/refunds";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";

export default async function RefundsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) => listRefunds(ctx, { limit: 200 }));

  return (
    <AppShell title="Refunds" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Money paid back to customers: for returned items, or out of their credit.</p>
          <Link href="/ar/refunds/new" className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" /> New refund
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2">Customer</th>
                <th className="text-left font-medium px-3 py-2 w-28">For</th>
                <th className="text-left font-medium px-3 py-2">Paid from</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">No refunds yet.</td></tr>
              )}
              {page.data.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/ar/refunds/${r.id}`} className="text-primary hover:underline">{r.refundNumber}</Link>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.refundDate}</td>
                  <td className="px-3 py-2">{r.customerName}</td>
                  <td className="px-3 py-2 text-xs">{r.kind === "credit" ? "Credit" : "Returned items"}</td>
                  <td className="px-3 py-2 text-xs">{r.bankAccountName}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(r.totalAmount, { currency: r.currency })}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
