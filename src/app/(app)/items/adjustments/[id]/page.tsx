import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { getInventoryAdjustment } from "@/lib/inventory/adjustments";
import { formatMoney, money, sumMoney } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { VoidAdjustment } from "./void-adjustment";

export default async function InventoryAdjustmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const a = await runAs(actor, (ctx) => getInventoryAdjustment(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(a);
  const total = sumMoney(a.lines.map((l) => l.value));

  return (
    <AppShell title={a.label} crumb={`${organization.name} · Sales · Inventory Adjustments`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em] text-foreground">{a.adjustmentNumber}</div>
            <div className="text-sm mt-1">{a.label.replace(` ${a.adjustmentNumber}`, "")}{a.memo ? ` · ${a.memo}` : ""}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>Dated {a.adjustmentDate}</span>
              <span>·</span>
              <span>Offset {a.offsetAccountName}</span>
              <StatusBadge status={a.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          {a.status === "posted" && hasRole(actor.role, "admin") && !actor.support && <VoidAdjustment id={a.id} number={a.adjustmentNumber} />}
        </div>
        {a.status === "voided" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            Voided{a.voidReason ? `: ${a.voidReason}` : ""}. Its quantities no longer count, and later sales of these items recosted.
          </div>
        )}

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-10">#</th>
                <th className="text-left font-medium px-3 py-2">Product</th>
                <th className="text-right font-medium px-3 py-2 w-28">Change</th>
                <th className="text-right font-medium px-3 py-2 w-28">Unit cost</th>
                <th className="text-right font-medium px-3 py-2 w-32">Value</th>
              </tr>
            </thead>
            <tbody>
              {a.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.lineNumber}</td>
                  <td className="px-3 py-2">
                    <Link href={`/items/${l.itemId}`} className="text-primary hover:underline">{l.itemName}</Link>
                    {l.sku && <span className="ml-2 font-mono text-[11px] text-muted-foreground">{l.sku}</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {money(l.quantity).gt(0) ? "+" : ""}
                    {money(l.quantity).toDecimalPlaces(4).toString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{l.unitCost ? formatMoney(l.unitCost) : "by costing method"}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(l.value)}</td>
                </tr>
              ))}
              <tr className="border-t border-border bg-muted/30">
                <td colSpan={4} className="px-3 py-2 text-xs font-semibold">Net change in inventory value</td>
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold">{formatMoney(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {a.journalIds.length > 0 && (
          <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
            <span>Journals:</span>
            {a.journalIds.map((j) => (
              <Link key={j} href={`/gl/${j}`} className="text-primary hover:underline">
                {j === a.glJournalId ? "stock added" : j === a.voidGlJournalId ? "void" : "cost of stock removed"}
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
