import Decimal from "decimal.js";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import { items, qboIdMap } from "@/lib/db/schema";
import { createInventoryAdjustment } from "@/lib/inventory/adjustments";
import { flushRecosting, holdRecosting, stockOf } from "@/lib/inventory/engine";
import { money, toDbMoney } from "@/lib/money";
import type { Kit, Step } from "./kit";

/**
 * Stock on hand as QuickBooks has it. After the history, each inventory
 * item's quantity and value here are compared with QuickBooks' Inventory
 * Valuation Summary; where they differ, one adjustment dated the import day
 * takes the item's stock out at its cost here and puts QuickBooks' quantity
 * back at QuickBooks' value, against the item's cost of goods sold account.
 */

type Cell = { value?: string; id?: string };
type Row = { ColData?: Cell[]; Rows?: { Row?: Row[] } };
type Report = { Columns?: { Column?: Array<{ ColTitle?: string; MetaData?: Array<{ Name?: string; Value?: string }> }> }; Rows?: { Row?: Row[] } };

const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** QuickBooks item id → quantity and asset value. */
function valuation(report: Report): Map<string, { qty: Decimal; value: Decimal }> {
  const cols = report.Columns?.Column ?? [];
  const at = (key: string, title: RegExp) => {
    const byKey = cols.findIndex((c) => c.MetaData?.some((m) => m.Name === "ColKey" && m.Value === key));
    return byKey >= 0 ? byKey : cols.findIndex((c) => title.test(c.ColTitle ?? ""));
  };
  const qtyAt = at("QtyOnHand", /^qty/i);
  const valueAt = at("AssetValue", /asset value/i);
  const out = new Map<string, { qty: Decimal; value: Decimal }>();
  const num = (c: Cell | undefined) => money((c?.value ?? "").replace(/,/g, "") || "0");
  const walk = (rows: Row[] | undefined) => {
    for (const r of rows ?? []) {
      const id = r.ColData?.[0]?.id;
      if (id && qtyAt >= 0 && valueAt >= 0) out.set(id, { qty: num(r.ColData?.[qtyAt]), value: num(r.ColData?.[valueAt]) });
      walk(r.Rows?.Row);
    }
  };
  walk(report.Rows?.Row);
  return out;
}

export const stockStep: Step = {
  key: "stock",
  label: "Stock on hand",
  async run(kit: Kit) {
    const today = format(new Date(), "yyyy-MM-dd");
    const theirs = valuation(await kit.client.report<Report>("InventoryValuationSummary", { report_date: today }));
    const stocked = await kit.ctx.tx
      .select({ item: items, qboId: qboIdMap.qboId })
      .from(items)
      .innerJoin(qboIdMap, and(eq(qboIdMap.localId, items.id), eq(qboIdMap.entity, "Item"), eq(qboIdMap.organizationId, kit.org)))
      .where(and(eq(items.organizationId, kit.org), eq(items.type, "inventory")));
    // Costs here must be current before they're compared.
    await flushRecosting(kit.ctx);
    holdRecosting(kit.ctx);
    await kit.year(today);

    const byOffset = new Map<string, Array<{ itemId: string; quantity: string; unitCost?: string }>>();
    for (const { item, qboId } of stocked) {
      const ours = await stockOf(kit.ctx, item.id);
      const q = theirs.get(qboId) ?? { qty: money(0), value: money(0) };
      if (ours.onHand.eq(q.qty) && round2(ours.value).eq(round2(q.value))) continue;
      const what = `${item.name}: ${ours.onHand.toString()} on hand worth ${round2(ours.value).toFixed(2)} here, ${q.qty.toString()} worth ${round2(q.value).toFixed(2)} in QuickBooks`;
      if (!item.isActive || !item.expenseAccountId || q.qty.lt(0)) {
        kit.note(`${what}. Not adjusted (${!item.isActive ? "the item is inactive" : q.qty.lt(0) ? "QuickBooks has it below zero" : "it has no cost of goods sold account"}); adjust it by hand.`);
        continue;
      }
      const lines = byOffset.get(item.expenseAccountId) ?? [];
      if (!ours.onHand.isZero()) {
        // Out at its cost here (a shortfall comes back in at the current unit cost).
        lines.push({ itemId: item.id, quantity: toDbMoney(ours.onHand.neg()), ...(ours.onHand.lt(0) ? { unitCost: toDbMoney(ours.unitCost) } : {}) });
      }
      if (q.qty.gt(0)) lines.push({ itemId: item.id, quantity: toDbMoney(q.qty), unitCost: toDbMoney(q.value.div(q.qty)) });
      byOffset.set(item.expenseAccountId, lines);
      kit.note(`${what}. An inventory adjustment dated ${today} matches QuickBooks.`);
      kit.count("stock", "imported");
    }
    for (const [offsetAccountId, lines] of byOffset) {
      if (lines.length === 0) continue;
      await createInventoryAdjustment(kit.ctx, {
        adjustmentDate: today,
        offsetAccountId,
        memo: "Matches stock on hand to QuickBooks (QuickBooks import)",
        lines,
      });
    }
    return { done: true, position: 1 };
  },
};
