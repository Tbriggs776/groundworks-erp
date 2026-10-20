/**
 * End-to-end: purchase orders. Approval through the bill thresholds
 * (approved on submit when the submitter's role meets the tier), editing
 * rules, partial billing (percent, custom, remaining), the PO closing when
 * fully billed and reopening when a bill is lowered, deleted, or voided,
 * manual close and reopen, the bill-side guards, the PDF, and the role /
 * agent rules.
 *
 *   npx tsx scripts/test-purchase-orders.ts
 */
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { approvalThresholds, items, vendors } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as bills from "../src/lib/ap/bills";
import * as pos from "../src/lib/ap/purchase-orders";
import { money } from "../src/lib/money";
import { purchaseOrderPdf } from "../src/lib/pdf/documents";
import { listReviewQueue } from "../src/lib/review";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

async function main() {
  const t = await createTestOrg("po-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);
  const fixed = (v: string | null | undefined) => money(v ?? 0).toFixed(2);

  const materials = account(t, "5100");
  const supplies = account(t, "6100");
  const [vendor] = await db
    .insert(vendors)
    .values({
      organizationId: t.org.id,
      code: "V-1",
      name: "Lumber Co",
      addresses: [{ type: "mailing", street1: "1 Mill Rd", city: "Boise", state: "ID", zip: "83702" }],
    })
    .returning();
  const [other] = await db.insert(vendors).values({ organizationId: t.org.id, code: "V-2", name: "Other Co" }).returning();
  const [inactive] = await db.insert(vendors).values({ organizationId: t.org.id, code: "V-3", name: "Gone Co", isActive: false }).returning();
  const [studs] = await db
    .insert(items)
    .values({
      organizationId: t.org.id,
      name: "2x4 stud",
      type: "non_inventory",
      description: "2x4x8 SPF stud",
      incomeAccountId: account(t, "4100").id,
      purchaseCost: "5.25",
      expenseAccountId: materials.id,
    })
    .returning();
  const [noCost] = await db
    .insert(items)
    .values({ organizationId: t.org.id, name: "Consulting", incomeAccountId: account(t, "4100").id })
    .returning();

  // Tiers: under 1000 an accountant approves, under 50000 an admin, above that the owner.
  await db.update(approvalThresholds).set({ isActive: false }).where(eq(approvalThresholds.organizationId, t.org.id));
  await db.insert(approvalThresholds).values([
    { organizationId: t.org.id, scope: "ap_bill", tierName: "Small", minAmount: "0", maxAmount: "1000", requiredRole: "accountant", sortOrder: 10 },
    { organizationId: t.org.id, scope: "ap_bill", tierName: "Medium", minAmount: "1000", maxAmount: "50000", requiredRole: "admin", sortOrder: 20 },
    { organizationId: t.org.id, scope: "ap_bill", tierName: "Large", minAmount: "50000", maxAmount: null, requiredRole: "owner", sortOrder: 30 },
  ]);

  const twoLines = (vendorId = vendor.id) => ({
    vendorId,
    poDate: "2026-04-01",
    expectedDate: "2026-04-15",
    shipTo: { street1: "9 Job Site Ln", city: "Mesa", state: "AZ", zip: "85201" },
    vendorMessage: "Deliver to the back gate.",
    lines: [
      { itemId: studs.id, quantity: "100" },
      { accountId: supplies.id, description: "Fasteners", quantity: "1", unitCost: "300" },
    ],
  });

  section("Create and edit");
  let poId = "";
  await check("an item fills the account, cost, and description; total = 525 + 300", async () => {
    const po = await run(bookkeeper, (ctx) => pos.createPurchaseOrder(ctx, twoLines()));
    poId = po.id;
    assertEq(po.status, "draft", "status");
    assert(po.poNumber.startsWith("PO-"), po.poNumber);
    assertEq(fixed(po.totalAmount), "825.00", "total");
    assertEq(po.lines[0].accountId, materials.id, "item's expense account");
    assertEq(fixed(po.lines[0].unitCost), "5.25", "item's purchase cost");
    assertEq(po.lines[0].description, "2x4x8 SPF stud", "item's description");
    assertEq(po.shipTo.street1, "9 Job Site Ln", "ship to");
  });
  await check("guards: no account, no cost, inactive vendor, expected before ordered", async () => {
    await expectError(
      () => run(bookkeeper, (ctx) => pos.createPurchaseOrder(ctx, { vendorId: vendor.id, poDate: "2026-04-01", lines: [{ description: "x", unitCost: "1" }] })),
      "invalid_input"
    );
    await expectError(
      () => run(bookkeeper, (ctx) => pos.createPurchaseOrder(ctx, { vendorId: vendor.id, poDate: "2026-04-01", lines: [{ itemId: noCost.id, accountId: supplies.id }] })),
      "invalid_input"
    );
    await expectError(() => run(bookkeeper, (ctx) => pos.createPurchaseOrder(ctx, twoLines(inactive.id))), "invalid_input");
    await expectError(
      () => run(bookkeeper, (ctx) => pos.createPurchaseOrder(ctx, { ...twoLines(), expectedDate: "2026-03-01" })),
      "invalid_input"
    );
    await expectError(() => run(viewer, (ctx) => pos.createPurchaseOrder(ctx, twoLines())), "forbidden");
  });
  await check("drafts can be edited; nothing can be billed or sent yet", async () => {
    const po = await run(bookkeeper, (ctx) =>
      pos.updatePurchaseOrder(ctx, { id: poId, ...twoLines(), lines: [{ itemId: studs.id, quantity: "100" }, { accountId: supplies.id, description: "Fasteners", unitCost: "300" }] })
    );
    assertEq(fixed(po.totalAmount), "825.00", "total");
    await expectError(() => run(bookkeeper, (ctx) => pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-20" })), "invalid_state");
    await expectError(() => run(bookkeeper, (ctx) => pos.markPurchaseOrderSent(ctx, { id: poId })), "invalid_state");
  });

  section("Approval (bill thresholds)");
  await check("a bookkeeper's submit waits; a bookkeeper can't approve; an accountant can", async () => {
    const po = await run(bookkeeper, (ctx) => pos.submitPurchaseOrder(ctx, { id: poId }));
    assertEq(po.status, "pending_approval", "waits");
    await expectError(() => run(bookkeeper, (ctx) => pos.approvePurchaseOrder(ctx, { id: poId })), "forbidden");
    await expectError(() => run(bookkeeper, (ctx) => pos.updatePurchaseOrder(ctx, { id: poId, ...twoLines() })), "invalid_state");
    const approved = await run(accountant, (ctx) => pos.approvePurchaseOrder(ctx, { id: poId }));
    assertEq(approved.status, "open", "open");
    assert(approved.approvedAt, "approvedAt");
  });
  await check("an accountant submitting under 1000 approves it in the same step", async () => {
    const po = await run(accountant, (ctx) => pos.createPurchaseOrder(ctx, { ...twoLines(), submit: true }));
    assertEq(po.status, "open", "open at once");
  });
  await check("over 1000 an accountant's submit waits for an admin", async () => {
    const po = await run(accountant, (ctx) =>
      pos.createPurchaseOrder(ctx, { vendorId: vendor.id, poDate: "2026-04-02", lines: [{ accountId: supplies.id, unitCost: "5000" }], submit: true })
    );
    assertEq(po.status, "pending_approval", "waits");
    await expectError(() => run(accountant, (ctx) => pos.approvePurchaseOrder(ctx, { id: po.id })), "forbidden");
    assertEq((await run(admin, (ctx) => pos.approvePurchaseOrder(ctx, { id: po.id }))).status, "open", "admin approves");
  });
  await check("reject, fix, resubmit; rejected and draft POs delete, open ones don't", async () => {
    const po = await run(bookkeeper, (ctx) => pos.createPurchaseOrder(ctx, { ...twoLines(), submit: true }));
    const rejected = await run(accountant, (ctx) => pos.rejectPurchaseOrder(ctx, { id: po.id, reason: "Too many studs" }));
    assertEq(rejected.status, "rejected", "rejected");
    assertEq(rejected.rejectionReason, "Too many studs", "reason");
    const fixed = await run(bookkeeper, (ctx) => pos.updatePurchaseOrder(ctx, { id: po.id, ...twoLines(), lines: [{ itemId: studs.id, quantity: "10" }] }));
    assertEq(fixed.status, "draft", "back to draft");
    await run(bookkeeper, (ctx) => pos.deleteDraftPurchaseOrder(ctx, { id: po.id }));
    await expectError(() => run(owner, (ctx) => pos.getPurchaseOrder(ctx, { id: po.id })), "not_found");
    await expectError(() => run(owner, (ctx) => pos.deleteDraftPurchaseOrder(ctx, { id: poId })), "invalid_state");
  });

  section("Partial billing");
  let firstBillId = "";
  await check("50% of each line: a draft bill of 412.50 that remembers its PO lines", async () => {
    const b = await run(bookkeeper, (ctx) =>
      pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-20", vendorInvoiceNumber: "LC-1", mode: "percent", percent: "50" })
    );
    firstBillId = b.id;
    assertEq(b.status, "draft", "draft bill");
    assertEq(b.purchaseOrderId, poId, "bill links the PO");
    assertEq(fixed(b.totalAmount), "412.50", "half of 825");
    assert(b.lines.every((l) => l.purchaseOrderLineId), "every line links its PO line");
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    assertEq(fixed(po.remainingAmount), "412.50", "left to bill");
    assertEq(po.status, "open", "still open");
    assertEq(po.bills.length, 1, "bill listed on the PO");
  });
  let customBillId = "";
  await check("custom: 100 on line 1; more than what's left is refused", async () => {
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    const [l1, l2] = po.lines;
    const b = await run(bookkeeper, (ctx) =>
      pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-21", mode: "custom", lines: [{ purchaseOrderLineId: l1.id, amount: "100" }] })
    );
    customBillId = b.id;
    assertEq(fixed(b.totalAmount), "100.00", "custom amount");
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-21", mode: "custom", lines: [{ purchaseOrderLineId: l2.id, amount: "150.01" }] })
        ),
      "invalid_input"
    );
  });
  let lastBillId = "";
  await check("everything left: the PO closes on its own", async () => {
    const b = await run(bookkeeper, (ctx) => pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-22" }));
    lastBillId = b.id;
    assertEq(fixed(b.totalAmount), "312.50", "the rest");
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    assertEq(po.status, "closed", "closed");
    assertEq(po.closeReason, null, "closed by billing, not by hand");
    assertEq(fixed(po.remainingAmount), "0.00", "nothing left");
    await expectError(() => run(bookkeeper, (ctx) => pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-23" })), "invalid_state");
    await expectError(() => run(bookkeeper, (ctx) => pos.reopenPurchaseOrder(ctx, { id: poId })), "invalid_state");
  });

  section("Bills keep the PO honest");
  await check("editing a bill from the PO can't bill past it; lowering it reopens the PO", async () => {
    const b = await run(owner, (ctx) => bills.getBill(ctx, { id: customBillId }));
    const asInput = (amount: string) => ({
      id: b.id,
      vendorId: b.vendorId,
      billDate: b.billDate,
      lines: b.lines.map((l) => ({ accountId: l.accountId, amount, description: l.description, purchaseOrderLineId: l.purchaseOrderLineId })),
    });
    await expectError(() => run(bookkeeper, (ctx) => bills.updateBill(ctx, asInput("100.01"))), "invalid_input");
    await run(bookkeeper, (ctx) => bills.updateBill(ctx, asInput("60")));
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    assertEq(po.status, "open", "reopened");
    assertEq(fixed(po.remainingAmount), "40.00", "40 back");
    // The vendor can't change on a bill from a PO.
    await expectError(() => run(bookkeeper, (ctx) => bills.updateBill(ctx, { ...asInput("60"), vendorId: other.id })), "invalid_input");
  });
  await check("a bill can't point at PO lines unless it was made from the PO", async () => {
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          bills.createBill(ctx, {
            vendorId: vendor.id,
            billDate: "2026-04-25",
            lines: [{ accountId: materials.id, amount: "1", purchaseOrderLineId: po.lines[0].id }],
          })
        ),
      "invalid_input"
    );
  });
  await check("deleting a draft bill gives its lines back", async () => {
    await run(bookkeeper, (ctx) => bills.deleteDraftBill(ctx, { id: lastBillId }));
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    assertEq(fixed(po.remainingAmount), "352.50", "40 + 312.50 back");
    assertEq(po.status, "open", "open");
  });
  await check("voiding a posted bill from the PO reopens a PO that billing closed", async () => {
    await run(owner, async (ctx) => {
      await bills.submitBill(ctx, { id: firstBillId });
      await bills.approveBill(ctx, { id: firstBillId });
      await bills.postBill(ctx, { id: firstBillId });
    });
    const rest = await run(bookkeeper, (ctx) => pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-26" }));
    assertEq((await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }))).status, "closed", "closed again");
    await run(admin, (ctx) => bills.voidBill(ctx, { id: firstBillId, reason: "Wrong invoice" }));
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    assertEq(po.status, "open", "reopened");
    assertEq(fixed(po.remainingAmount), "412.50", "the voided bill's share is back");
    assertEq(po.bills.find((x) => x.id === rest.id)?.status, "draft", "other bills untouched");
  });

  section("Sent, closed by hand, reopened");
  await check("mark sent; close with a reason; a bill void doesn't reopen it; reopen by hand", async () => {
    const sent = await run(bookkeeper, (ctx) => pos.markPurchaseOrderSent(ctx, { id: poId }));
    assert(sent.sentAt, "sentAt");
    const closed = await run(bookkeeper, (ctx) => pos.closePurchaseOrder(ctx, { id: poId, reason: "Rest back-ordered" }));
    assertEq(closed.status, "closed", "closed");
    assertEq(closed.closeReason, "Rest back-ordered", "reason");
    await expectError(() => run(bookkeeper, (ctx) => pos.createBillFromPurchaseOrder(ctx, { id: poId, billDate: "2026-04-27" })), "invalid_state");
    const draftBill = closed.bills.find((b) => b.status === "draft")!;
    await run(bookkeeper, (ctx) => bills.deleteDraftBill(ctx, { id: draftBill.id }));
    assertEq((await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }))).status, "closed", "stays closed");
    const reopened = await run(bookkeeper, (ctx) => pos.reopenPurchaseOrder(ctx, { id: poId }));
    assertEq(reopened.status, "open", "reopened");
    assertEq(reopened.closeReason, null, "reason cleared");
  });

  section("PDF");
  await check("the PO renders with the PO number in the file name", async () => {
    const f = await run(viewer, (ctx) => purchaseOrderPdf(ctx, poId));
    assertEq(f.bytes.subarray(0, 5).toString(), "%PDF-", "PDF bytes");
    const po = await run(viewer, (ctx) => pos.getPurchaseOrder(ctx, { id: poId }));
    assertEq(f.fileName, `PurchaseOrder_${po.poNumber}.pdf`, "file name");
  });

  section("Agents");
  await check("an agent's PO always waits for a person, and lands in the review queue", async () => {
    const token = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Buyer bot", role: "accountant", autonomy: "post" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const agent = await authenticateApiKey(token, "api");
    const po = await run(agent, (ctx) =>
      pos.createPurchaseOrder(ctx, { vendorId: vendor.id, poDate: "2026-05-01", lines: [{ accountId: supplies.id, unitCost: "50" }], submit: true })
    );
    assertEq(po.status, "pending_approval", "waits even under the agent's tier");
    await expectError(() => run(agent, (ctx) => pos.approvePurchaseOrder(ctx, { id: po.id })), "forbidden");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(queue.some((q) => q.type === "purchase_order" && q.id === po.id && q.reason === "awaiting_approval"), "in the review queue");
    assertEq((await run(accountant, (ctx) => pos.approvePurchaseOrder(ctx, { id: po.id }))).status, "open", "a person approves");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
