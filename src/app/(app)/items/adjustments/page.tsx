import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { adjustmentLabel, listInventoryAdjustments } from "@/lib/inventory/adjustments";

export default async function InventoryAdjustmentsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) => listInventoryAdjustments(ctx, { limit: 200 }));
  return (
    <AppShell title="Inventory Adjustments" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <div className="space-y-4 max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Stock counts, damage, loss, found stock, and opening stock.</p>
          <Link
            href="/items/adjustments/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New adjustment
          </Link>
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Number</th>
                <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                <th className="text-left font-medium px-3 py-2 w-36">Kind</th>
                <th className="text-left font-medium px-3 py-2">Memo</th>
                <th className="text-left font-medium px-3 py-2">Offset account</th>
                <th className="text-right font-medium px-3 py-2 w-16">Items</th>
                <th className="text-left font-medium px-3 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">No inventory adjustments yet.</td></tr>
              )}
              {page.data.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/items/adjustments/${a.id}`} className="text-primary hover:underline">{a.adjustmentNumber}</Link>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{a.adjustmentDate}</td>
                  <td className="px-3 py-2 text-xs">{adjustmentLabel(a).replace(` ${a.adjustmentNumber}`, "")}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{a.memo ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{a.offsetAccountName}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{a.lineCount}</td>
                  <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
