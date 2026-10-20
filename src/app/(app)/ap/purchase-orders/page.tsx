import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listPurchaseOrders } from "@/lib/ap/purchase-orders";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";

const FILTERS = [
  ["", "All"],
  ["open", "Open"],
  ["pending_approval", "Waiting for approval"],
  ["draft", "Drafts"],
  ["closed", "Closed"],
] as const;

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const status = FILTERS.some(([s]) => s && s === sp.status) ? (sp.status as "open" | "pending_approval" | "draft" | "closed") : undefined;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) => listPurchaseOrders(ctx, { status, limit: 200 }));
  return (
    <AppShell title="Purchase Orders" crumb={`${organization.name} · Expenses`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map(([s, name]) => (
              <Link
                key={s}
                href={s ? `/ap/purchase-orders?status=${s}` : "/ap/purchase-orders"}
                className={`rounded-md border px-2.5 py-1 text-xs ${(status ?? "") === s ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border text-muted-foreground hover:bg-accent"}`}
              >
                {name}
              </Link>
            ))}
          </div>
          <Link
            href="/ap/purchase-orders/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New purchase order
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2">Vendor</th>
                <th className="text-left font-medium px-3 py-2 w-28">Expected</th>
                <th className="text-right font-medium px-3 py-2 w-32">Total</th>
                <th className="text-right font-medium px-3 py-2 w-32">Left to bill</th>
                <th className="text-left font-medium px-3 py-2 w-36">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">No purchase orders here yet.</td></tr>
              )}
              {page.data.map((po) => {
                const left = money(po.totalAmount).minus(money(po.billedAmount));
                return (
                  <tr key={po.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/ap/purchase-orders/${po.id}`} className="text-primary hover:underline">{po.poNumber}</Link>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{po.poDate}</td>
                    <td className="px-3 py-2">{po.vendorName}</td>
                    <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{po.expectedDate ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(po.totalAmount, { currency: po.currency })}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {po.status === "open" && left.gt(0) ? formatMoney(left, { currency: po.currency }) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={po.status} />
                      {po.sentAt && po.status === "open" && <span className="ml-1.5 text-[10px] text-muted-foreground">sent</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
