import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listCustomerPayments } from "@/lib/ar/payments";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";

export default async function CustomerPaymentsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) => listCustomerPayments(ctx, { limit: 200 }));

  return (
    <AppShell title="Payments Received" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {page.data.length} payment{page.data.length === 1 ? "" : "s"}.
          </div>
          <Link
            href="/ar/payments/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Receive payment
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Payment #</th>
                <th className="text-left font-medium px-3 py-2">Customer</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2 w-28">Method</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                <th className="text-left font-medium px-3 py-2 w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No payments received yet.
                  </td>
                </tr>
              )}
              {page.data.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/ar/payments/${p.id}`} className="text-primary hover:underline">
                      {p.paymentNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{p.customerName}</td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{p.paymentDate}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground uppercase">{p.method.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(p.amount, { currency: p.currency })}
                    {money(p.discountAmount).gt(0) && (
                      <div className="text-[10px] text-muted-foreground">
                        + {formatMoney(p.discountAmount, { currency: p.currency })} discount
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
