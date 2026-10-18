/**
 * End-to-end: bill lifecycle through the service layer (the same code the
 * web UI, REST API, and MCP server call) — approval routing, role + scope
 * gates, GL posting through AP control, duplicate detection, tenant
 * isolation, agent rules, and void.
 *
 *   npx tsx scripts/test-ap-bills.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  apBills,
  approvalThresholds,
  auditLog,
  glJournals,
  glLines,
  vendors,
} from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import { canApproveAtRole, resolveApprovalRouting } from "../src/lib/ap/approval";
import * as bills from "../src/lib/ap/bills";
import * as billPayments from "../src/lib/ap/bill-payments";
import { money } from "../src/lib/money";
import {
  account,
  assert,
  assertEq,
  check,
  createTestOrg,
  deleteOrgs,
  expectError,
  finish,
  section,
} from "./lib/harness";

async function main() {
  const t = await createTestOrg("ap-test-");
  const other = await createTestOrg("ap-other-");
  console.log(`\nTest org: ${t.org.slug}`);

  const [vendor] = await db
    .insert(vendors)
    .values({ organizationId: t.org.id, code: "VEND-001", name: "ABC Office Supply", defaultPaymentTermsDays: 30 })
    .returning();

  const owner = t.as("owner");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const supplies = account(t, "6620");
  const rent = account(t, "6600");
  const apControl = account(t, "2000");
  const checking = account(t, "1010");

  const routing = (amount: string) =>
    t.run(owner, ({ tx }) => resolveApprovalRouting(tx, t.org.id, "ap_bill", amount));

  section("Approval thresholds");
  await check("default threshold: admin required for any amount", async () => {
    const r = await routing("5000");
    assertEq(r.requiredRole, "admin", "requiredRole");
    assert(!r.fallback, "should hit the seeded Default tier, not fallback");
  });

  await check("tiers: small<1000 accountant / med<50000 admin / large owner", async () => {
    await db
      .update(approvalThresholds)
      .set({ isActive: false })
      .where(eq(approvalThresholds.organizationId, t.org.id));
    await db.insert(approvalThresholds).values([
      { organizationId: t.org.id, scope: "ap_bill", tierName: "Small", minAmount: "0", maxAmount: "1000", requiredRole: "accountant", sortOrder: 10 },
      { organizationId: t.org.id, scope: "ap_bill", tierName: "Medium", minAmount: "1000", maxAmount: "50000", requiredRole: "admin", sortOrder: 20 },
      { organizationId: t.org.id, scope: "ap_bill", tierName: "Large", minAmount: "50000", maxAmount: null, requiredRole: "owner", sortOrder: 30 },
    ]);
    assertEq((await routing("500")).threshold?.tierName, "Small", "500");
    assertEq((await routing("25000")).threshold?.tierName, "Medium", "25000");
    assertEq((await routing("75000")).requiredRole, "owner", "75000");
  });

  await check("rank checks", async () => {
    assert(canApproveAtRole("admin", "accountant"), "admin ≥ accountant");
    assert(!canApproveAtRole("accountant", "admin"), "accountant < admin");
    assert(canApproveAtRole("owner", "owner"), "owner ≥ owner");
  });

  section("Create + gates");
  let billId = "";
  await check("bookkeeper creates a draft; due date defaults from vendor terms", async () => {
    const b = await t.run(bookkeeper, (ctx) =>
      bills.createBill(ctx, {
        vendorId: vendor.id,
        vendorInvoiceNumber: "INV-12345",
        billDate: "2026-03-15",
        description: "Supplies for March",
        lines: [
          { accountId: supplies.id, amount: "600", description: "Paper" },
          { accountId: rent.id, amount: 200 },
        ],
      })
    );
    billId = b.id;
    assertEq(b.status, "draft", "status");
    assertEq(b.dueDate, "2026-04-14", "dueDate");
    assertEq(money(b.totalAmount).toFixed(2), "800.00", "total");
    assertEq(b.lines.length, 2, "lines");
    assert(b.billNumber.startsWith("BILL-"), `billNumber ${b.billNumber}`);
    assertEq(b.createdBy, t.owner.id, "createdBy");
  });

  await check("duplicate vendor invoice # is rejected", async () => {
    await expectError(
      () =>
        t.run(bookkeeper, (ctx) =>
          bills.createBill(ctx, {
            vendorId: vendor.id,
            vendorInvoiceNumber: "INV-12345",
            billDate: "2026-03-16",
            lines: [{ accountId: supplies.id, amount: "1" }],
          })
        ),
      "conflict"
    );
  });

  await check("viewer cannot create bills", async () => {
    await expectError(
      () =>
        t.run(viewer, (ctx) =>
          bills.createBill(ctx, {
            vendorId: vendor.id,
            billDate: "2026-03-16",
            lines: [{ accountId: supplies.id, amount: "1" }],
          })
        ),
      "forbidden"
    );
  });

  await check("control account on a line is rejected", async () => {
    await expectError(
      () =>
        t.run(bookkeeper, (ctx) =>
          bills.createBill(ctx, {
            vendorId: vendor.id,
            billDate: "2026-03-16",
            lines: [{ accountId: apControl.id, amount: "1" }],
          })
        ),
      "invalid_input"
    );
  });

  await check("another org's account id is rejected", async () => {
    await expectError(
      () =>
        t.run(bookkeeper, (ctx) =>
          bills.createBill(ctx, {
            vendorId: vendor.id,
            billDate: "2026-03-16",
            lines: [{ accountId: account(other, "6620").id, amount: "1" }],
          })
        ),
      "not_found"
    );
  });

  await check("bad input reports the field", async () => {
    const err = await expectError(
      () =>
        t.run(bookkeeper, (ctx) =>
          bills.createBill(ctx, {
            vendorId: vendor.id,
            billDate: "2026-02-30",
            lines: [{ accountId: supplies.id, amount: "1" }],
          })
        ),
      "invalid_input"
    );
    assert(err.message.startsWith("billDate"), err.message);
  });

  section("Approve + post");
  await check("submit → pending_approval", async () => {
    const b = await t.run(bookkeeper, (ctx) => bills.submitBill(ctx, { id: billId }));
    assertEq(b.status, "pending_approval", "status");
  });

  await check("bookkeeper cannot approve", async () => {
    await expectError(
      () => t.run(bookkeeper, (ctx) => bills.approveBill(ctx, { id: billId })),
      "forbidden"
    );
  });

  await check("accountant approves an 800 bill (Small tier)", async () => {
    const b = await t.run(t.as("accountant"), (ctx) => bills.approveBill(ctx, { id: billId }));
    assertEq(b.status, "approved", "status");
  });

  await check("post: Dr expenses / Cr AP control, balanced", async () => {
    const b = await t.run(t.as("accountant"), (ctx) => bills.postBill(ctx, { id: billId }));
    assertEq(b.status, "posted", "status");
    assert(b.glJournalId, "glJournalId");
    const lines = await db.select().from(glLines).where(eq(glLines.journalId, b.glJournalId!));
    assertEq(lines.length, 3, "line count");
    const ap = lines.find((l) => l.accountId === apControl.id)!;
    assertEq(money(ap.credit).toFixed(2), "800.00", "AP credit");
    const [j] = await db.select().from(glJournals).where(eq(glJournals.id, b.glJournalId!));
    assertEq(j.source, "ap", "source");
    assertEq(j.status, "posted", "journal status");
  });

  await check("open balance shows on the bill", async () => {
    const b = await t.run(viewer, (ctx) => bills.getBill(ctx, { id: billId }));
    assertEq(money(b.openBalance).toFixed(2), "800.00", "openBalance");
  });

  section("Void rules");
  await check("cannot void a bill with posted payments", async () => {
    await t.run(owner, (ctx) =>
      billPayments.createBillPayment(ctx, {
        vendorId: vendor.id,
        paymentDate: "2026-03-20",
        method: "ach",
        bankAccountId: checking.id,
        applications: [{ billId, amount: "100" }],
        post: true,
      })
    );
    await expectError(
      () => t.run(owner, (ctx) => bills.voidBill(ctx, { id: billId, reason: "test" })),
      "invalid_state"
    );
  });

  await check("void a clean bill: reversal posted, status voided", async () => {
    const b2 = await t.run(owner, async (ctx) => {
      const b = await bills.createBill(ctx, {
        vendorId: vendor.id,
        billDate: "2026-03-18",
        lines: [{ accountId: supplies.id, amount: "50" }],
        submit: true,
      });
      await bills.approveBill(ctx, { id: b.id });
      return bills.postBill(ctx, { id: b.id });
    });
    const v = await t.run(owner, (ctx) => bills.voidBill(ctx, { id: b2.id, reason: "entered twice" }));
    assertEq(v.status, "voided", "status");
    const [orig] = await db.select().from(glJournals).where(eq(glJournals.id, b2.glJournalId!));
    assertEq(orig.status, "reversed", "original journal");
  });

  section("Reject + edit");
  await check("reject → rejected; saving puts it back to draft", async () => {
    const b = await t.run(bookkeeper, (ctx) =>
      bills.createBill(ctx, {
        vendorId: vendor.id,
        billDate: "2026-03-19",
        lines: [{ accountId: supplies.id, amount: "75" }],
        submit: true,
      })
    );
    const r = await t.run(owner, (ctx) => bills.rejectBill(ctx, { id: b.id, reason: "wrong account" }));
    assertEq(r.status, "rejected", "rejected");
    assertEq(r.rejectionReason, "wrong account", "reason");
    const u = await t.run(bookkeeper, (ctx) =>
      bills.updateBill(ctx, {
        id: b.id,
        vendorId: vendor.id,
        billDate: "2026-03-19",
        lines: [{ accountId: rent.id, amount: "75" }],
      })
    );
    assertEq(u.status, "draft", "after edit");
    assertEq(u.rejectionReason, null, "reason cleared");
  });

  section("Agents");
  const agentActor: Actor = {
    ...t.as("accountant"),
    kind: "agent",
    userId: null,
    agentId: null, // set below
    agentName: "Test agent",
    scopes: ["read", "write", "post"],
    channel: "api",
    maxPostAmount: "100",
  };
  await check("an agent cannot approve a bill it created", async () => {
    const [agentRow] = await db.execute<{ id: string }>(
      sql`INSERT INTO agents (organization_id, name, role, autonomy) VALUES (${t.org.id}, 'AP bot', 'accountant', 'post') RETURNING id`
    );
    agentActor.agentId = agentRow.id;
    const b = await t.run(agentActor, (ctx) =>
      bills.createBill(ctx, {
        vendorId: vendor.id,
        billDate: "2026-03-21",
        lines: [{ accountId: supplies.id, amount: "40" }],
        submit: true,
      })
    );
    assertEq(b.createdByAgentId, agentActor.agentId, "createdByAgentId");
    await expectError(
      () => t.run(agentActor, (ctx) => bills.approveBill(ctx, { id: b.id })),
      "forbidden"
    );
  });

  await check("agent posting above its limit is left for review", async () => {
    const b = await t.run(owner, async (ctx) => {
      const created = await bills.createBill(ctx, {
        vendorId: vendor.id,
        billDate: "2026-03-22",
        lines: [{ accountId: supplies.id, amount: "500" }],
        submit: true,
      });
      return bills.approveBill(ctx, { id: created.id });
    });
    const err = await expectError(
      () => t.run(agentActor, (ctx) => bills.postBill(ctx, { id: b.id })),
      "approval_required"
    );
    assert(/posting limit/.test(err.message), err.message);
    const [after] = await db.select().from(apBills).where(eq(apBills.id, b.id));
    assertEq(after.status, "approved", "still approved");
  });

  await check("agent actions are attributed in the audit log", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, t.org.id), eq(auditLog.agentId, agentActor.agentId!)));
    assert(rows.length >= 2, `expected agent audit rows, got ${rows.length}`);
    assert(rows.every((r) => r.actorType === "agent" && r.channel === "api"), "actorType/channel");
  });

  await deleteOrgs("ap-test-");
  await deleteOrgs("ap-other-");
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
