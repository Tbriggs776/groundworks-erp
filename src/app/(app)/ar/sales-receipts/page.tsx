import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listSalesReceipts } from "@/lib/ar/sales-receipts";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";

export default async function SalesReceiptsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) => listSalesReceipts(ctx, { limit: 200 }));

  return (
    <AppShell title="Sales Receipts" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Sales paid on the spot. Money in Undeposited Funds waits for a bank deposit.</p>
          <Link href="/ar/sales-receipts/new" className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" /> New sales receipt
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2">Customer</th>
                <th className="text-left font-medium px-3 py-2">Deposited to</th>
                <th className="text-right font-medium px-3 py-2 w-32">Total</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">No sales receipts yet.</td></tr>
              )}
              {page.data.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/ar/sales-receipts/${r.id}`} className="text-primary hover:underline">{r.receiptNumber}</Link>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.receiptDate}</td>
                  <td className="px-3 py-2">{r.customerName ?? <span className="text-muted-foreground">No customer</span>}</td>
                  <td className="px-3 py-2 text-xs">{r.depositAccountName}</td>
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
