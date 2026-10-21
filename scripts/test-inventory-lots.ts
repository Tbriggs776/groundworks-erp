/**
 * End-to-end: inventory part 2. Specific identification by lot (lot
 * numbers on every inventory line, expiration dates, each lot costed on
 * its own, short lots filled by the next stock into them), vendor credits
 * sending stock back (COGS keeps the difference), billing purchase orders
 * by quantity, the stock status report (reorder, on order, expiring lots),
 * and the valuation detail report tying to the ledger.
 *
 *   npx tsx scripts/test-inventory-lots.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { inventoryMovements } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as bills from "../src/lib/ap/bills";
import * as purchaseOrders from "../src/lib/ap/purchase-orders";
import * as vendorCredits from "../src/lib/ap/vendor-credits";
import * as creditMemos from "../src/lib/ar/credit-memos";
import * as invoices from "../src/lib/ar/invoices";
import * as items from "../src/lib/ar/items";
import * as adjustments from "../src/lib/inventory/adjustments";
import * as lots from "../src/lib/inventory/lots";
import * as stock from "../src/lib/inventory/stock";
import { money } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import { reportTable } from "../src/lib/reports/exports";
import type { ReportTable } from "../src/lib/reports/table";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section, type TestOrg } from "./lib/harness";

async function gl(t: TestOrg, code: string) {
  const [r] = await db.execute<{ b: string | null }>(sql`
    SELECT SUM(l.debit_local - l.credit_local)::text AS b FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
     WHERE l.organization_id = ${t.org.id} AND l.account_id = ${account(t, code).id} AND j.status IN ('posted', 'reversed')`);
  return money(r?.b ?? 0).toFixed(2);
}

async function costOf(t: TestOrg, sourceId: string) {
  const ms = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.organizationId, t.org.id), eq(inventoryMovements.sourceId, sourceId)));
  return ms.map((m) => money(m.cost).toFixed(2)).join(",");
}

const row = (table: ReportTable, label: string) => {
  const r = table.rows.find((x) => x.label === label);
  if (!r) throw new Error(`no row "${label}" in ${table.title}: ${table.rows.map((x) => x.label).join(" | ")}`);
  return r.values;
};

async function main() {
  const t = await createTestOrg("inventory-lots-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);
  const vendor = await run(owner, (ctx) => parties.createVendor(ctx, { name: "Supplier" }));
  const buyer = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Buyer" }));
  const returner = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Returner" }));
  const lotsOf = async (itemId: string) =>
    (await run(viewer, (ctx) => lots.listLots(ctx, { itemId })))
      .map((l) => `${l.lotNumber}:${money(l.onHand).toString()}@${money(l.value).toFixed(2)}`)
      .join(" ");
  const bill = (billDate: string, lines: bills.CreateBillInput["lines"]) =>
    run(owner, async (ctx) => {
      const b = await bills.createBill(ctx, { vendorId: vendor.id, billDate, lines, submit: true });
      await bills.approveBill(ctx, { id: b.id });
      return bills.postBill(ctx, { id: b.id });
    });
  const valuationTies = async () => {
    const v = await run(viewer, (ctx) => reportTable(ctx, { report: "inventory-valuation" }));
    const total = v.rows.find((r) => r.kind === "total")!.values[2];
    assertEq(total, await gl(t, "1300"), "the valuation ties to 1300");
    return total;
  };

  section("Specific identification");
  let widget!: Awaited<ReturnType<typeof items.createItem>>;
  await check("the method is chosen once; opening stock needs a lot", async () => {
    await run(admin, (ctx) => stock.updateInventorySettings(ctx, { costingMethod: "specific" }));
    await expectError(
      () => run(owner, (ctx) => items.createItem(ctx, { name: "Widget", type: "inventory", salesPrice: "30", incomeAccountId: account(t, "4000").id, openingStock: { quantity: "10", unitCost: "10", asOf: "2026-01-05" } })),
      "invalid_input"
    );
    widget = await run(owner, (ctx) =>
      items.createItem(ctx, {
        name: "Widget",
        type: "inventory",
        salesPrice: "30",
        reorderPoint: "10",
        incomeAccountId: account(t, "4000").id,
        openingStock: { quantity: "10", unitCost: "10", asOf: "2026-01-05", lotNumber: "L1", lotExpiresOn: "2027-06-30" },
      })
    );
    assertEq(await lotsOf(widget.id), "L1:10@100.00", "lot L1");
  });

  await check("a bill starts a lot; posting without a lot is refused", async () => {
    await expectError(() => bill("2026-02-01", [{ itemId: widget.id, quantity: "10", unitCost: "12" }]), "invalid_input");
    await bill("2026-02-01", [{ itemId: widget.id, quantity: "10", unitCost: "12", lotNumber: "L2", lotExpiresOn: "2026-11-10" }]);
    assertEq(await lotsOf(widget.id), "L2:10@120.00 L1:10@100.00", "soonest to expire first");
  });

  let sale!: Awaited<ReturnType<typeof invoices.createInvoice>>;
  await check("a sale costs the units of its own lot, not the oldest", async () => {
    await expectError(
      () => run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: buyer.id, invoiceDate: "2026-03-01", lines: [{ itemId: widget.id, quantity: "5", lotNumber: "NOPE" }] })),
      "invalid_input"
    );
    await expectError(
      () => run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: buyer.id, invoiceDate: "2026-03-01", lines: [{ itemId: widget.id, quantity: "5" }], post: true })),
      "invalid_input"
    );
    sale = await run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: buyer.id, invoiceDate: "2026-03-01", lines: [{ itemId: widget.id, quantity: "5", lotNumber: "L2" }], post: true }));
    assertEq(await costOf(t, sale.id), "60.00", "5 × 12 from L2 (FIFO would say 50)");
    assertEq(await lotsOf(widget.id), "L2:5@60.00 L1:10@100.00", "L2 down 5");
  });

  await check("selling past a lot's stock: the next stock into that lot fills it", async () => {
    const short = await run(owner, (ctx) =>
      invoices.createInvoice(ctx, { customerId: buyer.id, invoiceDate: "2026-03-05", lines: [{ itemId: widget.id, quantity: "12", lotNumber: "L1" }], post: true })
    );
    assertEq(await costOf(t, short.id), "120.00", "10 × 10 + 2 short at 10");
    await run(owner, (ctx) =>
      adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-03-10", offsetAccountId: account(t, "5900").id, lines: [{ itemId: widget.id, quantity: "3", unitCost: "11", lotNumber: "L1" }] })
    );
    assertEq(await costOf(t, short.id), "122.00", "the 2 short filled at 11");
    assertEq(await lotsOf(widget.id), "L2:5@60.00 L1:1@11.00", "L1 has 1 left");
    await valuationTies();
  });

  let memo!: Awaited<ReturnType<typeof creditMemos.createCreditMemo>>;
  await check("a return goes back into its lot at what that lot last went out at", async () => {
    memo = await run(owner, (ctx) =>
      creditMemos.createCreditMemo(ctx, { customerId: returner.id, memoDate: "2026-03-15", lines: [{ itemId: widget.id, quantity: "1", lotNumber: "L2" }], post: true })
    );
    assertEq(await costOf(t, memo.id), "12.00", "back in at 12");
    assertEq(await lotsOf(widget.id), "L2:6@72.00 L1:1@11.00", "L2 back to 6");
  });

  section("Vendor credits send stock back");
  await check("units leave their lot at cost; COGS keeps the difference", async () => {
    const cogsBefore = money(await gl(t, "5050"));
    const vc = await run(owner, (ctx) =>
      vendorCredits.createVendorCredit(ctx, { vendorId: vendor.id, creditDate: "2026-03-20", lines: [{ itemId: widget.id, quantity: "2", unitCost: "15", lotNumber: "L2" }], post: true })
    );
    assertEq(`${vc.lines[0].accountId === account(t, "5050").id} ${money(vc.totalAmount).toFixed(2)}`, "true 30.00", "credits COGS 30");
    assertEq(await costOf(t, vc.id), "24.00", "2 × 12 out of L2");
    assertEq(money(await gl(t, "5050")).minus(cogsBefore).toFixed(2), "-6.00", "COGS down by the 6 over cost");
    assertEq(await lotsOf(widget.id), "L2:4@48.00 L1:1@11.00", "L2 down 2");
    await valuationTies();
    await run(admin, (ctx) => vendorCredits.voidVendorCredit(ctx, { id: vc.id, reason: "Not sent" }));
    assertEq(await lotsOf(widget.id), "L2:6@72.00 L1:1@11.00", "back after the void");
    assertEq(money(await gl(t, "5050")).minus(cogsBefore).toFixed(2), "0.00", "COGS back too");
    await valuationTies();
  });

  section("Purchase orders by quantity");
  let po!: Awaited<ReturnType<typeof purchaseOrders.createPurchaseOrder>>;
  await check("bill what was received: quantity × unit cost, into a lot", async () => {
    const before = await run(viewer, (ctx) => reportTable(ctx, { report: "inventory-stock-status" }));
    assertEq(row(before, "Widget").join("|"), "7|10|||2026-11-10|Reorder · Lot expiring", "at the reorder point, nothing on order; L2 expires within 30 days");
    po = await run(owner, (ctx) =>
      purchaseOrders.createPurchaseOrder(ctx, { vendorId: vendor.id, poDate: "2026-04-01", expectedDate: "2026-04-20", lines: [{ itemId: widget.id, quantity: "10", unitCost: "3.333" }] })
    );
    const submitted = await run(owner, (ctx) => purchaseOrders.submitPurchaseOrder(ctx, { id: po.id }));
    if (submitted.status === "pending_approval") await run(owner, (ctx) => purchaseOrders.approvePurchaseOrder(ctx, { id: po.id }));
    const status = await run(viewer, (ctx) => reportTable(ctx, { report: "inventory-stock-status" }));
    assertEq(row(status, "Widget").join("|"), "7|10|10|2026-04-20|2026-11-10|On order · Lot expiring", "low, but 10 on order");
    await expectError(
      () => run(owner, (ctx) => purchaseOrders.createBillFromPurchaseOrder(ctx, { id: po.id, billDate: "2026-04-10", mode: "quantity", lines: [{ purchaseOrderLineId: po.lines[0].id, quantity: "11" }] })),
      "invalid_input"
    );
    const first = await run(owner, (ctx) =>
      purchaseOrders.createBillFromPurchaseOrder(ctx, { id: po.id, billDate: "2026-04-10", mode: "quantity", lines: [{ purchaseOrderLineId: po.lines[0].id, quantity: "3", lotNumber: "L3" }], submit: true })
    );
    assertEq(`${money(first.lines[0].quantity!).toString()} ${money(first.lines[0].amount).toFixed(2)} ${first.lines[0].lotNumber}`, "3 10.00 L3", "3 × 3.333");
    const after = await run(viewer, (ctx) => purchaseOrders.getPurchaseOrder(ctx, { id: po.id }));
    assertEq(`${money(after.lines[0].billedQuantity).toString()} ${money(after.lines[0].remainingQuantity).toString()}`, "3 7", "3 received, 7 to go");
    const rest = await run(owner, (ctx) =>
      purchaseOrders.createBillFromPurchaseOrder(ctx, { id: po.id, billDate: "2026-04-12", mode: "quantity", lines: [{ purchaseOrderLineId: po.lines[0].id, quantity: "7", lotNumber: "L3" }], submit: true })
    );
    assertEq(money(rest.lines[0].amount).toFixed(2), "23.33", "the rest of the line's 33.33");
    for (const b of [first, rest]) {
      await run(owner, async (ctx) => {
        if (b.status === "pending_approval") await bills.approveBill(ctx, { id: b.id });
        await bills.postBill(ctx, { id: b.id });
      });
    }
    assertEq(await lotsOf(widget.id), "L2:6@72.00 L1:1@11.00 L3:10@33.33", "L3 in stock (no expiry: last)");
    const status2 = await run(viewer, (ctx) => reportTable(ctx, { report: "inventory-stock-status" }));
    assertEq(row(status2, "Widget").join("|"), "17|10|||2026-11-10|Lot expiring", "all received: above the reorder point");
    assertEq(row(status2, "Lot L2").slice(4).join("|"), "2026-11-10|Expiring", "the lot row");
  });

  section("Valuation detail");
  await check("opening, every change, and closing per item, tied to the ledger", async () => {
    const d = await run(viewer, (ctx) => reportTable(ctx, { report: "inventory-valuation-detail", from: "2026-03-01", to: "2026-12-31" }));
    assertEq(row(d, "Opening balance").slice(3).join("|"), "20|220.00", "Jan and Feb: 10 × 10 + 10 × 12");
    const closing = row(d, "Total Widget");
    assertEq(`${closing[3]} ${closing[4]}`, `17 ${await gl(t, "1300")}`, "closing ties to 1300");
    assertEq(row(d, "Total inventory")[4], await valuationTies(), "and to the valuation report");
    assert(d.rows.some((r) => r.label === "Void of Vendor credit VC-000001"), "voids show on their own day");
  });

  section("Lots are for specific identification only");
  await check("a FIFO company can't send lot numbers", async () => {
    const f = await createTestOrg("inventory-lots-fifo-test-");
    const gadget = await f.run(f.as("owner"), (ctx) => items.createItem(ctx, { name: "Gadget", type: "inventory", salesPrice: "5", incomeAccountId: account(f, "4000").id }));
    const v = await f.run(f.as("owner"), (ctx) => parties.createVendor(ctx, { name: "V" }));
    await expectError(
      () => f.run(f.as("owner"), (ctx) => bills.createBill(ctx, { vendorId: v.id, billDate: "2026-02-01", lines: [{ itemId: gadget.id, quantity: "1", unitCost: "2", lotNumber: "X" }] })),
      "invalid_input"
    );
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
