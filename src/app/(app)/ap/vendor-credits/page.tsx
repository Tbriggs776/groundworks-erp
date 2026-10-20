import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listVendorCredits } from "@/lib/ap/vendor-credits";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";

export default async function VendorCreditsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) => listVendorCredits(ctx, { limit: 200 }));
  return (
    <AppShell title="Vendor Credits" crumb={`${organization.name} · Expenses`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Credits from vendors. Use them on their bills, or record the refund when the money comes back.</p>
          <Link
            href="/ap/vendor-credits/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New vendor credit
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2">Vendor</th>
                <th className="text-left font-medium px-3 py-2 w-32">Vendor ref</th>
                <th className="text-right font-medium px-3 py-2 w-32">Total</th>
                <th className="text-right font-medium px-3 py-2 w-32">Unused</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">No vendor credits yet.</td></tr>
              )}
              {page.data.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/ap/vendor-credits/${c.id}`} className="text-primary hover:underline">{c.creditNumber}</Link>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{c.creditDate}</td>
                  <td className="px-3 py-2">{c.vendorName}</td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{c.vendorReference ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(c.totalAmount, { currency: c.currency })}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{money(c.remaining).gt(0) ? formatMoney(c.remaining, { currency: c.currency }) : "—"}</td>
                  <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
