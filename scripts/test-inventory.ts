/**
 * End-to-end: inventory. The costing method (set once), inventory items
 * with opening stock, purchases on bills and checks, cost of goods sold on
 * invoices and sales receipts, returns on credit memos, adjustments, and
 * the engine recosting everything when something is backdated or voided:
 * FIFO and weighted average, selling past zero and the next stock filling
 * it, hard-closed periods pushing cost entries to the first open day, soft
 * closed ones taking them. The valuation report ties to the ledger
 * throughout. Plus who may do what, and agent posting limits.
 *
 *   npx tsx scripts/test-inventory.ts
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { fiscalPeriods, glJournals, inventoryCostPostings, inventoryMovements } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as bills from "../src/lib/ap/bills";
import * as purchaseOrders from "../src/lib/ap/purchase-orders";
import * as creditMemos from "../src/lib/ar/credit-memos";
import * as invoices from "../src/lib/ar/invoices";
import * as items from "../src/lib/ar/items";
import * as salesReceipts from "../src/lib/ar/sales-receipts";
import { OPERATIONS } from "../src/lib/api/operations";
import * as bank from "../src/lib/banking/transactions";
import * as adjustments from "../src/lib/inventory/adjustments";
import * as stock from "../src/lib/inventory/stock";
import { money } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import { reportTable } from "../src/lib/reports/exports";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section, type TestOrg } from "./lib/harness";

async function setup(prefix: string) {
  const t = await createTestOrg(prefix);
  const owner = t.as("owner");
  const vendor = await t.run(owner, (ctx) => parties.createVendor(ctx, { name: "Supplier" }));
  const buyer = await t.run(owner, (ctx) => parties.createCustomer(ctx, { name: "Buyer" }));
  const returner = await t.run(owner, (ctx) => parties.createCustomer(ctx, { name: "Returner" }));
  return { t, owner, vendor, buyer, returner };
}

/** An account's ledger balance (debit − credit), optionally as of a date. */
async function gl(t: TestOrg, code: string, asOf?: string) {
  const [r] = await db.execute<{ b: string | null }>(sql`
    SELECT SUM(l.debit_local - l.credit_local)::text AS b FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
     WHERE l.organization_id = ${t.org.id} AND l.account_id = ${account(t, code).id}
       AND j.status IN ('posted', 'reversed') ${asOf ? sql`AND j.journal_date <= ${asOf}::date` : sql``}`);
  return money(r?.b ?? 0).toFixed(2);
}

async function onHand(t: TestOrg, itemId: string) {
  const s = await t.run(t.as("viewer"), (ctx) => stock.getItemStock(ctx, { id: itemId }));
  return `${money(s.onHand).toString()} @ ${money(s.value).toFixed(2)}`;
}

/** What the engine says a document's movements cost, and what the ledger carries. */
async function costOf(t: TestOrg, sourceId: string) {
  const ms = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.organizationId, t.org.id), eq(inventoryMovements.sourceId, sourceId)));
  return ms.map((m) => `${money(m.cost).toFixed(2)}/${money(m.bookedCost).toFixed(2)}`).join(",");
}

async function valuation(t: TestOrg, asOf?: string) {
  const table = await t.run(t.as("viewer"), (ctx) => reportTable(ctx, { report: "inventory-valuation", asOf }));
  const total = table.rows.find((r) => r.kind === "total")!.values[2]!;
  return { table, total };
}

const bill = (t: TestOrg, actor: Actor, vendorId: string, billDate: string, lines: bills.CreateBillInput["lines"]) =>
  t.run(actor, async (ctx) => {
    const b = await bills.createBill(ctx, { vendorId, billDate, lines, submit: true });
    await bills.approveBill(ctx, { id: b.id });
    return bills.postBill(ctx, { id: b.id });
  });

const setPeriod = (t: TestOrg, from: string, to: string, status: "open" | "soft_closed" | "hard_closed") =>
  db
    .update(fiscalPeriods)
    .set({ status })
    .where(and(eq(fiscalPeriods.organizationId, t.org.id), gte(fiscalPeriods.startDate, from), lte(fiscalPeriods.endDate, to)));

async function main() {
  const { t, owner, vendor, buyer, returner } = await setup("inventory-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);
  const sales = account(t, "4000");
  const checking = account(t, "1010");
  const shrinkage = account(t, "5900");

  section("Costing method");
  await check("FIFO by default; admins choose it until the first stock movement", async () => {
    assertEq(JSON.stringify(await run(viewer, (ctx) => stock.getInventorySettings(ctx))), '{"costingMethod":"fifo","locked":false}', "default");
    await expectError(() => run(accountant, (ctx) => stock.updateInventorySettings(ctx, { costingMethod: "average" })), "forbidden");
    assertEq((await run(admin, (ctx) => stock.updateInventorySettings(ctx, { costingMethod: "average" }))).costingMethod, "average", "changed");
    await run(admin, (ctx) => stock.updateInventorySettings(ctx, { costingMethod: "fifo" }));
  });

  let widget!: Awaited<ReturnType<typeof items.createItem>>;
  section("Inventory items and opening stock");
  await check("an inventory item defaults its asset and COGS accounts; opening stock posts against equity", async () => {
    const writer: Actor = { ...bookkeeper, kind: "agent", userId: null, agentId: crypto.randomUUID(), agentName: "Writer", scopes: ["read", "write"] };
    await expectError(
      () => run(writer, (ctx) => items.createItem(ctx, { name: "Widget", type: "inventory", incomeAccountId: sales.id, openingStock: { quantity: "10", unitCost: "10", asOf: "2026-01-05" } })),
      "forbidden"
    );
    widget = await run(bookkeeper, (ctx) =>
      items.createItem(ctx, { name: "Widget", sku: "W-1", type: "inventory", incomeAccountId: sales.id, salesPrice: "30", purchaseCost: "10", reorderPoint: "3", openingStock: { quantity: "10", asOf: "2026-01-05" } })
    );
    assertEq(widget.assetAccountId, account(t, "1300").id, "asset account 1300");
    assertEq(widget.expenseAccountId, account(t, "5050").id, "COGS 5050");
    assertEq(await onHand(t, widget.id), "10 @ 100.00", "opening stock");
    assertEq(`${await gl(t, "1300")} ${await gl(t, "3300")}`, "100.00 -100.00", "Dr inventory / Cr opening balance equity");
    const list = await run(viewer, (ctx) => adjustments.listInventoryAdjustments(ctx, {}));
    assertEq(list.data.map((a) => `${a.adjustmentNumber}:${a.kind}`).join(), "IA-000001:opening", "an opening adjustment");
    const row = (await run(viewer, (ctx) => items.listItems(ctx, { type: "inventory" }))).data[0];
    assertEq(`${money(row.onHand!).toString()} ${money(row.stockValue!).toFixed(2)}`, "10 100.00", "the list shows stock");
    await expectError(() => run(admin, (ctx) => stock.updateInventorySettings(ctx, { costingMethod: "average" })), "invalid_state");
    assertEq((await run(viewer, (ctx) => stock.getInventorySettings(ctx))).locked, true, "locked");
  });

  await check("an item with stock stays inventory and keeps its asset account; COGS can change", async () => {
    await expectError(() => run(owner, (ctx) => items.updateItem(ctx, { id: widget.id, type: "non_inventory" })), "invalid_state");
    await expectError(() => run(owner, (ctx) => items.updateItem(ctx, { id: widget.id, assetAccountId: account(t, "1200").id })), "invalid_input");
    const other = await run(owner, (ctx) => items.updateItem(ctx, { id: widget.id, expenseAccountId: account(t, "5900").id }));
    assertEq(other.expenseAccountId, account(t, "5900").id, "COGS changed");
    await run(owner, (ctx) => items.updateItem(ctx, { id: widget.id, expenseAccountId: account(t, "5050").id }));
  });

  section("FIFO: purchases, sales, backdating, negative stock");
  let invoice!: Awaited<ReturnType<typeof invoices.createInvoice>>;
  let lateBill!: Awaited<ReturnType<typeof bills.postBill>>;
  await check("a bill line with a quantity buys into stock at the item's asset account", async () => {
    await expectError(() => bill(t, owner, vendor.id, "2026-02-01", [{ itemId: widget.id, amount: "120" }]), "invalid_input");
    const b = await bill(t, owner, vendor.id, "2026-02-01", [{ itemId: widget.id, quantity: "10", unitCost: "12" }]);
    assertEq(`${b.lines[0].accountId === account(t, "1300").id} ${money(b.totalAmount).toFixed(2)}`, "true 120.00", "1300, 10 × 12");
    assertEq(await onHand(t, widget.id), "20 @ 220.00", "20 on hand");
  });

  await check("an invoice costs the oldest units first: 10 × 10 + 5 × 12", async () => {
    invoice = await run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: buyer.id, invoiceDate: "2026-03-01", lines: [{ itemId: widget.id, quantity: "15" }], post: true }));
    assertEq(await costOf(t, invoice.id), "160.00/160.00", "cost of goods");
    assertEq(`${await gl(t, "5050")} ${await gl(t, "1300")}`, "160.00 60.00", "Dr COGS / Cr inventory");
    const [j] = await db
      .select({ d: glJournals.description, date: glJournals.journalDate })
      .from(glJournals)
      .where(and(eq(glJournals.organizationId, t.org.id), eq(glJournals.source, "inventory"), eq(glJournals.journalDate, "2026-03-01")));
    assertEq(`${j.d} ${j.date}`, `Cost of goods: Invoice ${invoice.invoiceNumber} 2026-03-01`, "on the invoice date");
  });

  await check("a bill dated before the sale recosts it on the sale's date", async () => {
    lateBill = await bill(t, owner, vendor.id, "2026-01-10", [{ itemId: widget.id, quantity: "5", unitCost: "8" }]);
    assertEq(await costOf(t, invoice.id), "140.00/140.00", "10 × 10 + 5 × 8");
    assertEq(`${await gl(t, "5050")} ${await gl(t, "1300")}`, "140.00 120.00", "COGS down 20");
    const [p] = await db.select().from(inventoryCostPostings).where(and(eq(inventoryCostPostings.organizationId, t.org.id), eq(inventoryCostPostings.amount, "-20.0000")));
    assertEq(p?.postedOn, "2026-03-01", "the recost posts on the invoice date");
    assertEq(await onHand(t, widget.id), "10 @ 120.00", "10 left at 12");
  });

  let receipt!: Awaited<ReturnType<typeof salesReceipts.createSalesReceipt>>;
  await check("selling past zero is allowed: the units short cost the last known unit cost", async () => {
    receipt = await run(owner, (ctx) =>
      salesReceipts.createSalesReceipt(ctx, { receiptDate: "2026-04-01", method: "cash", lines: [{ itemId: widget.id, quantity: "12" }], post: true })
    );
    assertEq(await costOf(t, receipt.id), "144.00/144.00", "10 × 12 + 2 × 12");
    assertEq(await onHand(t, widget.id), "-2 @ -24.00", "negative stock");
    const { table, total } = await valuation(t);
    assertEq(table.rows[0].values[3], "Negative", "flagged");
    assertEq(total, await gl(t, "1300"), "ties to the ledger");
  });

  await check("a check buying stock fills the shortfall at its own cost", async () => {
    await expectError(
      () => run(owner, (ctx) => bank.createDeposit(ctx, { txnDate: "2026-05-01", bankAccountId: checking.id, lines: [{ itemId: widget.id, quantity: "1", unitCost: "5" }] })),
      "invalid_input"
    );
    const chk = await run(owner, (ctx) =>
      bank.createExpense(ctx, { type: "check", txnDate: "2026-05-01", bankAccountId: checking.id, reference: "1001", lines: [{ itemId: widget.id, quantity: "4", unitCost: "15" }], post: true })
    );
    assertEq(chk.status, "posted", "posted");
    assertEq(await costOf(t, receipt.id), "150.00/150.00", "2 short filled at 15");
    assertEq(await onHand(t, widget.id), "2 @ 30.00", "2 left at 15");
  });

  let memo!: Awaited<ReturnType<typeof creditMemos.createCreditMemo>>;
  await check("a credit memo returns stock at what it last went out at", async () => {
    memo = await run(owner, (ctx) => creditMemos.createCreditMemo(ctx, { customerId: returner.id, memoDate: "2026-05-10", lines: [{ itemId: widget.id, quantity: "1" }], post: true }));
    assertEq(await costOf(t, memo.id), "12.00/12.00", "back in at 12");
    assertEq(await onHand(t, widget.id), "3 @ 42.00", "3 on hand");
  });

  let damaged!: adjustments.AdjustmentDetail;
  section("Adjustments");
  await check("removing stock costs it by FIFO against the offset; adding stock posts at the given cost", async () => {
    await expectError(() => run(viewer, (ctx) => adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-06-01", offsetAccountId: shrinkage.id, lines: [{ itemId: widget.id, quantity: "-1" }] })), "forbidden");
    await expectError(
      () => run(owner, (ctx) => adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-06-01", offsetAccountId: account(t, "1300").id, lines: [{ itemId: widget.id, quantity: "-1" }] })),
      "invalid_input"
    );
    await expectError(
      () => run(owner, (ctx) => adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-06-01", offsetAccountId: shrinkage.id, lines: [{ itemId: widget.id, quantity: "0" }] })),
      "invalid_input"
    );
    const service = await run(owner, (ctx) => items.createItem(ctx, { name: "Install", incomeAccountId: account(t, "4100").id }));
    await expectError(
      () => run(owner, (ctx) => adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-06-01", offsetAccountId: shrinkage.id, lines: [{ itemId: service.id, quantity: "1" }] })),
      "invalid_input"
    );
    const capped: Actor = { ...bookkeeper, kind: "agent", userId: null, agentId: crypto.randomUUID(), agentName: "Counter", maxPostAmount: "20" };
    await expectError(
      () => run(capped, (ctx) => adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-06-02", offsetAccountId: shrinkage.id, lines: [{ itemId: widget.id, quantity: "3", unitCost: "9" }] })),
      "approval_required"
    );
    damaged = await run(bookkeeper, (ctx) =>
      adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-06-01", offsetAccountId: shrinkage.id, memo: "Damaged", lines: [{ itemId: widget.id, quantity: "-1" }] })
    );
    assertEq(damaged.lines.map((l) => l.value).join(), "-15.0000", "the oldest unit left: 15");
    assertEq(await gl(t, "5900"), "15.00", "Dr shrinkage");
    const found = await run(bookkeeper, (ctx) =>
      adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-06-02", offsetAccountId: shrinkage.id, memo: "Found", lines: [{ itemId: widget.id, quantity: "3", unitCost: "9" }] })
    );
    assertEq(`${found.adjustmentNumber} ${found.lines[0].value} ${found.journalIds.length}`, "IA-000003 27.0000 1", "its own journal");
    assertEq(await gl(t, "5900"), "-12.00", "Cr shrinkage 27");
    assertEq(await onHand(t, widget.id), "5 @ 54.00", "5 on hand");
    const { total } = await valuation(t);
    assertEq(`${total} ${await gl(t, "1300")}`, "54.00 54.00", "ties to the ledger");
  });

  section("Voids, closed periods");
  await check("voiding a bill recosts later sales; a hard-closed period sends the entry to the first open day", async () => {
    await setPeriod(t, "2026-01-01", "2026-03-31", "hard_closed");
    await run(admin, (ctx) => bills.voidBill(ctx, { id: lateBill.id, reason: "Duplicate" }));
    assertEq(await costOf(t, invoice.id), "160.00/160.00", "back to 10 × 10 + 5 × 12");
    const posts = await db
      .select({ amount: inventoryCostPostings.amount, on: inventoryCostPostings.postedOn })
      .from(inventoryCostPostings)
      .innerJoin(inventoryMovements, eq(inventoryMovements.id, inventoryCostPostings.movementId))
      .where(eq(inventoryMovements.sourceId, invoice.id));
    assertEq(posts.map((p) => `${money(p.amount).toFixed(2)}@${p.on}`).join(), "160.00@2026-03-01,-20.00@2026-03-01,20.00@2026-04-01", "pushed to April 1");
    assertEq(await costOf(t, damaged.id), "9.00/9.00", "the damaged unit came from the shortfall: filled at 9");
    assertEq(await onHand(t, widget.id), "0 @ 0.00", "all gone");
    const { total } = await valuation(t);
    assertEq(`${total} ${await gl(t, "1300")}`, "0.00 0.00", "ties");
  });

  await check("voiding an invoice reverses its cost today; soft-closed periods take the recosts", async () => {
    await setPeriod(t, "2026-05-01", "2026-05-31", "soft_closed");
    await run(admin, (ctx) => invoices.voidInvoice(ctx, { id: invoice.id, reason: "Cancelled" }));
    assertEq(await costOf(t, invoice.id), "0.00/0.00", "nothing");
    assertEq(await costOf(t, receipt.id), "124.00/124.00", "10 × 10 + 2 × 12");
    assertEq(await costOf(t, memo.id), "10.33/10.33", "the return recosts too (in May, soft closed)");
    assertEq(await onHand(t, widget.id), "15 @ 181.33", "15 back on hand");
    const { total } = await valuation(t);
    assertEq(`${total} ${await gl(t, "1300")}`, "181.33 181.33", "ties");
  });

  await check("valuation as of a past date ties to the ledger on that date", async () => {
    for (const d of ["2026-01-31", "2026-03-15", "2026-04-15", "2026-06-30"]) {
      const { total } = await valuation(t, d);
      assertEq(total, await gl(t, "1300", d), `as of ${d}`);
    }
    const { table } = await valuation(t);
    assert(table.notes?.[0].includes("Matches."), table.notes?.[0] ?? "no note");
  });

  section("Weighted average");
  const b = await setup("inventory-avg-test-");
  await check("average cost, a backdated purchase, and a return at the average", async () => {
    await b.t.run(b.t.as("admin"), (ctx) => stock.updateInventorySettings(ctx, { costingMethod: "average" }));
    const gadget = await b.t.run(b.owner, (ctx) => items.createItem(ctx, { name: "Gadget", type: "inventory", salesPrice: "20", incomeAccountId: account(b.t, "4000").id }));
    await bill(b.t, b.owner, b.vendor.id, "2026-01-05", [{ itemId: gadget.id, quantity: "10", unitCost: "10" }]);
    await bill(b.t, b.owner, b.vendor.id, "2026-01-06", [{ itemId: gadget.id, quantity: "10", unitCost: "13" }]);
    const inv = await b.t.run(b.owner, (ctx) => invoices.createInvoice(ctx, { customerId: b.buyer.id, invoiceDate: "2026-02-01", lines: [{ itemId: gadget.id, quantity: "5" }], post: true }));
    assertEq(await costOf(b.t, inv.id), "57.50/57.50", "5 × 11.50");
    await bill(b.t, b.owner, b.vendor.id, "2026-01-04", [{ itemId: gadget.id, quantity: "5", unitCost: "7" }]);
    assertEq(await costOf(b.t, inv.id), "53.00/53.00", "5 × 10.60");
    const cm = await b.t.run(b.owner, (ctx) => creditMemos.createCreditMemo(ctx, { customerId: b.returner.id, memoDate: "2026-02-10", lines: [{ itemId: gadget.id, quantity: "1" }], post: true }));
    assertEq(await costOf(b.t, cm.id), "10.60/10.60", "back at the average");
    assertEq(await onHand(b.t, gadget.id), "21 @ 222.60", "21 on hand");
    const adj = await b.t.run(b.owner, (ctx) =>
      adjustments.createInventoryAdjustment(ctx, { adjustmentDate: "2026-03-01", offsetAccountId: account(b.t, "5900").id, lines: [{ itemId: gadget.id, quantity: "2", unitCost: "11" }] })
    );
    assertEq(await onHand(b.t, gadget.id), "23 @ 244.60", "2 found");
    await expectError(() => b.t.run(b.t.as("accountant"), (ctx) => adjustments.voidInventoryAdjustment(ctx, { id: adj.id, reason: "x" })), "forbidden");
    const voided = await b.t.run(b.t.as("admin"), (ctx) => adjustments.voidInventoryAdjustment(ctx, { id: adj.id, reason: "Miscounted" }));
    assertEq(`${voided.status} ${voided.journalIds.length}`, "voided 2", "its journal and the reversal");
    assertEq(await onHand(b.t, gadget.id), "21 @ 222.60", "back");
    const { total } = await valuation(b.t);
    assertEq(`${total} ${await gl(b.t, "1300")}`, "222.60 222.60", "ties");
  });

  await check("a purchase order of an inventory item bills its share of the quantity into stock", async () => {
    const gadget = (await b.t.run(b.owner, (ctx) => items.listItems(ctx, { type: "inventory" }))).data[0];
    const po = await b.t.run(b.owner, (ctx) =>
      purchaseOrders.createPurchaseOrder(ctx, { vendorId: b.vendor.id, poDate: "2026-03-05", lines: [{ itemId: gadget.id, quantity: "4", unitCost: "11" }] })
    );
    assertEq(po.lines[0].accountId, account(b.t, "1300").id, "the PO line debits inventory");
    const submitted = await b.t.run(b.owner, (ctx) => purchaseOrders.submitPurchaseOrder(ctx, { id: po.id }));
    if (submitted.status === "pending_approval") await b.t.run(b.owner, (ctx) => purchaseOrders.approvePurchaseOrder(ctx, { id: po.id }));
    const half = await b.t.run(b.owner, (ctx) => purchaseOrders.createBillFromPurchaseOrder(ctx, { id: po.id, billDate: "2026-03-06", mode: "percent", percent: "50", submit: true }));
    assertEq(`${money(half.lines[0].quantity!).toString()} ${money(half.lines[0].amount).toFixed(2)}`, "2 22.00", "half: 2 units");
    await b.t.run(b.owner, async (ctx) => {
      await bills.approveBill(ctx, { id: half.id });
      await bills.postBill(ctx, { id: half.id });
    });
    assertEq(await onHand(b.t, gadget.id), "23 @ 244.60", "2 more on hand");
  });

  section("API");
  await check("the inventory operations are in the registry", async () => {
    const names = new Set(OPERATIONS.map((o) => o.name));
    for (const n of [
      "get_inventory_settings",
      "update_inventory_settings",
      "get_item_stock",
      "list_inventory_adjustments",
      "get_inventory_adjustment",
      "create_inventory_adjustment",
      "void_inventory_adjustment",
      "report_inventory_valuation",
    ]) {
      assert(names.has(n), `missing ${n}`);
    }
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
