import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { getItemStock, METHOD_LABEL } from "@/lib/inventory/stock";
import { formatMoney, money } from "@/lib/money";

const KIND_LABEL: Record<string, string> = {
  opening: "Opening stock",
  purchase: "Bought",
  sale: "Sold",
  return: "Returned",
  adjustment: "Adjusted",
};

const qty = (v: string) => money(v).toDecimalPlaces(4).toString();

export default async function ItemStockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const s = await runAs(actor, (ctx) => getItemStock(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const negative = money(s.onHand).lt(0);
  const canAdjust = hasRole(actor.role, "bookkeeper") && actor.scopes.includes("post") && !actor.support;

  return (
    <AppShell title={s.item.name} crumb={`${organization.name} · Sales · Products & Services`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em] text-foreground">{s.item.name}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              {s.item.sku && <span className="font-mono">{s.item.sku}</span>}
              <span>Inventory · {METHOD_LABEL[s.costingMethod]}</span>
              {!s.item.isActive && <Badge variant="outline" className="text-[9px]">Inactive</Badge>}
              {s.belowReorderPoint && <Badge variant="secondary" className="text-[9px]">Reorder</Badge>}
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/items" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              All products
            </Link>
            {canAdjust && (
              <Link href={`/items/adjustments/new?itemId=${s.item.id}`} className={buttonVariants({ size: "sm" })}>
                Adjust quantity
              </Link>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Tile label="On hand" value={qty(s.onHand)} tone={negative ? "text-destructive" : undefined} />
          <Tile label="Value" value={formatMoney(s.value)} />
          <Tile label="Avg cost" value={formatMoney(s.unitCost)} />
          <Tile label="Reorder point" value={s.item.reorderPoint === null ? "—" : qty(s.item.reorderPoint)} />
        </div>
        {negative && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
            More has been sold than was on hand. The units short are costed at the last known cost; the next stock in fills them and their
            sales recost.
          </div>
        )}

        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            History{s.totalMovements > s.movements.length ? ` (latest ${s.movements.length} of ${s.totalMovements})` : ""}
          </div>
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                  <th className="text-left font-medium px-3 py-2 w-28">Type</th>
                  <th className="text-left font-medium px-3 py-2">Document</th>
                  <th className="text-right font-medium px-3 py-2 w-24">Quantity</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Cost</th>
                  <th className="text-right font-medium px-3 py-2 w-24">On hand</th>
                </tr>
              </thead>
              <tbody>
                {s.movements.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                      No stock yet. Buy it on a bill or expense, or add opening stock with an adjustment.
                    </td>
                  </tr>
                )}
                {s.movements.map((m) => (
                  <tr key={m.id} className={`border-t border-border ${m.voided ? "text-muted-foreground line-through" : ""}`}>
                    <td className="px-3 py-2 font-mono text-xs">{m.movementDate}</td>
                    <td className="px-3 py-2 text-xs">{KIND_LABEL[m.kind] ?? m.kind}</td>
                    <td className="px-3 py-2 text-xs">
                      {m.href ? (
                        <Link href={m.href} className="text-primary hover:underline">
                          {m.label}
                        </Link>
                      ) : (
                        m.label
                      )}
                      {m.voided && <span className="ml-2 no-underline">(voided)</span>}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono text-xs ${money(m.quantity).lt(0) ? "" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {money(m.quantity).gt(0) ? "+" : ""}
                      {qty(m.quantity)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{formatMoney(m.cost)}</td>
                    <td className={`px-3 py-2 text-right font-mono text-xs ${money(m.onHand).lt(0) ? "text-destructive" : ""}`}>
                      {m.voided ? "" : qty(m.onHand)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-lg mt-0.5 ${tone ?? ""}`}>{value}</div>
    </div>
  );
}
