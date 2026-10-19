/**
 * End-to-end: sales / AR through the service layer — customers (auto
 * codes), products & services, invoices (item defaults, rounding, discount
 * lines, GL), customer payments (auto-apply, discounts, guards), voids,
 * aging, and agent drafts.
 *
 *   npx tsx scripts/test-ar.ts
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { agents, glJournals, glLines } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as invoices from "../src/lib/ar/invoices";
import * as items from "../src/lib/ar/items";
import * as payments from "../src/lib/ar/payments";
import { getTrialBalance } from "../src/lib/gl/reports";
import { money, sumMoney } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import { arAging } from "../src/lib/reports/aging";
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
  const t = await createTestOrg("ar-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const bookkeeper = t.as("bookkeeper");
  const ar = account(t, "1200");
  const sales = account(t, "4000");
  const services = account(t, "4100");
  const undeposited = account(t, "1250");
  const salesDiscounts = account(t, "4950");

  const journalLines = (journalId: string) =>
    db.select().from(glLines).where(eq(glLines.journalId, journalId));
  const sideOf = (lines: Awaited<ReturnType<typeof journalLines>>, accountId: string, side: "debit" | "credit") =>
    sumMoney(lines.filter((l) => l.accountId === accountId).map((l) => l[side])).toFixed(2);

  section("Customers");
  let customerId = "";
  await check("code is derived from the name when omitted", async () => {
    const c = await t.run(bookkeeper, (ctx) =>
      parties.createCustomer(ctx, { name: "Acme Corp, LLC", email: "ap@acme.test" })
    );
    customerId = c.id;
    assertEq(c.code, "ACME-CORP-LLC", "code");
    assertEq(c.defaultPaymentTermsDays, 30, "terms");
    const c2 = await t.run(bookkeeper, (ctx) => parties.createCustomer(ctx, { name: "Acme Corp LLC" }));
    assertEq(c2.code, "ACME-CORP-LLC-2", "second code");
  });

  await check("search finds by name or email", async () => {
    const page = await t.run(owner, (ctx) => parties.listCustomers(ctx, { q: "ap@acme" }));
    assertEq(page.data.length, 1, "matches");
  });

  section("Products & services");
  let consultingId = "";
  let widgetId = "";
  await check("create a service and a non-inventory product", async () => {
    const [c, w] = await t.run(bookkeeper, async (ctx) => [
      await items.createItem(ctx, { name: "Consulting", salesPrice: "150", incomeAccountId: services.id }),
      await items.createItem(ctx, { name: "Widget", type: "non_inventory", salesPrice: 25, incomeAccountId: sales.id }),
    ]);
    consultingId = c.id;
    widgetId = w.id;
    assertEq(c.type, "service", "default type");
  });

  await check("an item can't credit a control account", async () => {
    await expectError(
      () => t.run(bookkeeper, (ctx) => items.createItem(ctx, { name: "Bad", incomeAccountId: ar.id })),
      "invalid_input"
    );
  });

  section("Invoices");
  let invoiceId = "";
  await check("draft from item defaults; half-up rounding; discount line", async () => {
    const inv = await t.run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, {
        customerId,
        invoiceDate: "2026-03-01",
        lines: [
          { itemId: consultingId, quantity: "10" },
          { itemId: widgetId, quantity: 3, unitPrice: "19.995" },
          { accountId: sales.id, description: "Loyalty discount", unitPrice: "-59.99" },
        ],
      })
    );
    invoiceId = inv.id;
    assertEq(inv.status, "draft", "status");
    assertEq(inv.dueDate, "2026-03-31", "due date from terms");
    assertEq(inv.lines[0].description, "Consulting", "description from item");
    assertEq(money(inv.lines[1].amount).toFixed(2), "59.99", "3 × 19.995 rounds half-up");
    assertEq(money(inv.totalAmount).toFixed(2), "1500.00", "total");
    assert(inv.invoiceNumber.startsWith("INV-"), inv.invoiceNumber);
  });

  await check("viewer can't create; inactive customer is refused", async () => {
    await expectError(
      () =>
        t.run(t.as("viewer"), (ctx) =>
          invoices.createInvoice(ctx, { customerId, invoiceDate: "2026-03-01", lines: [{ itemId: consultingId }] })
        ),
      "forbidden"
    );
    const off = await t.run(owner, (ctx) => parties.createCustomer(ctx, { name: "Gone Inc", isActive: false }));
    await expectError(
      () =>
        t.run(owner, (ctx) =>
          invoices.createInvoice(ctx, { customerId: off.id, invoiceDate: "2026-03-01", lines: [{ itemId: consultingId }] })
        ),
      "invalid_input"
    );
  });

  await check("post: Dr AR 1500 / Cr Services 1500 / Sales nets to zero", async () => {
    const inv = await t.run(bookkeeper, (ctx) => invoices.postInvoice(ctx, { id: invoiceId }));
    assertEq(inv.status, "open", "status");
    const lines = await journalLines(inv.glJournalId!);
    assertEq(sideOf(lines, ar.id, "debit"), "1500.00", "AR debit");
    assertEq(sideOf(lines, services.id, "credit"), "1500.00", "Services credit");
    assertEq(sideOf(lines, sales.id, "credit"), "59.99", "Sales credit");
    assertEq(sideOf(lines, sales.id, "debit"), "59.99", "Discount line debit");
    assert(lines.every((l) => l.customerId === customerId), "lines tagged with customer");
  });

  await check("posted invoices are not editable", async () => {
    await expectError(
      () =>
        t.run(owner, (ctx) =>
          invoices.updateInvoice(ctx, { id: invoiceId, customerId, invoiceDate: "2026-03-01", lines: [{ itemId: consultingId }] })
        ),
      "invalid_state"
    );
  });

  await check("customer open balance = 1500", async () => {
    const c = await t.run(owner, (ctx) => parties.getCustomer(ctx, { id: customerId }));
    assertEq(money(c.openBalance).toFixed(2), "1500.00", "openBalance");
  });

  section("Customer payments");
  let firstPaymentId = "";
  await check("auto-apply 1000 to Undeposited Funds; invoice stays open with 500", async () => {
    const p = await t.run(bookkeeper, (ctx) =>
      payments.createCustomerPayment(ctx, {
        customerId,
        paymentDate: "2026-03-20",
        method: "check",
        reference: "5521",
        amount: "1000",
        post: true,
      })
    );
    firstPaymentId = p.id;
    assertEq(p.depositAccountId, undeposited.id, "default deposit account");
    assertEq(p.applications.length, 1, "applications");
    const lines = await journalLines(p.glJournalId!);
    assertEq(sideOf(lines, undeposited.id, "debit"), "1000.00", "deposit debit");
    assertEq(sideOf(lines, ar.id, "credit"), "1000.00", "AR credit");
    const inv = await t.run(owner, (ctx) => invoices.getInvoice(ctx, { id: invoiceId }));
    assertEq(inv.status, "open", "status");
    assertEq(money(inv.openBalance).toFixed(2), "500.00", "openBalance");
  });

  await check("auto-apply beyond the open balance is refused", async () => {
    await expectError(
      () =>
        t.run(bookkeeper, (ctx) =>
          payments.createCustomerPayment(ctx, { customerId, paymentDate: "2026-03-21", method: "ach", amount: "600" })
        ),
      "invalid_input"
    );
  });

  let discountPaymentId = "";
  await check("490 cash + 10 discount pays it off: Dr Deposit 490 / Dr Sales Discounts 10 / Cr AR 500", async () => {
    const p = await t.run(bookkeeper, (ctx) =>
      payments.createCustomerPayment(ctx, {
        customerId,
        paymentDate: "2026-03-25",
        method: "ach",
        applications: [{ invoiceId, amount: "490", discountAmount: "10" }],
        post: true,
      })
    );
    discountPaymentId = p.id;
    const lines = await journalLines(p.glJournalId!);
    assertEq(sideOf(lines, undeposited.id, "debit"), "490.00", "deposit");
    assertEq(sideOf(lines, salesDiscounts.id, "debit"), "10.00", "discount");
    assertEq(sideOf(lines, ar.id, "credit"), "500.00", "AR");
    const inv = await t.run(owner, (ctx) => invoices.getInvoice(ctx, { id: invoiceId }));
    assertEq(inv.status, "paid", "invoice paid");
    assertEq(inv.payments.length, 2, "payments listed on invoice");
  });

  section("Voids");
  await check("a paid invoice can't be voided", async () => {
    await expectError(
      () => t.run(owner, (ctx) => invoices.voidInvoice(ctx, { id: invoiceId, reason: "x" })),
      "invalid_state"
    );
  });

  await check("bookkeeper can't void payments; admin can, invoice reopens", async () => {
    await expectError(
      () => t.run(bookkeeper, (ctx) => payments.voidCustomerPayment(ctx, { id: discountPaymentId, reason: "x" })),
      "forbidden"
    );
    const p = await t.run(t.as("admin"), (ctx) =>
      payments.voidCustomerPayment(ctx, { id: discountPaymentId, reason: "ACH returned" })
    );
    assertEq(p.status, "voided", "status");
    const [orig] = await db.select().from(glJournals).where(eq(glJournals.id, p.glJournalId!));
    assertEq(orig.status, "reversed", "journal reversed");
    const inv = await t.run(owner, (ctx) => invoices.getInvoice(ctx, { id: invoiceId }));
    assertEq(inv.status, "open", "reopened");
    assertEq(money(inv.openBalance).toFixed(2), "500.00", "balance restored");
  });

  section("Aging");
  await check("500 open, 45 days past due → 31–60 bucket", async () => {
    const r = await t.run(owner, (ctx) => arAging(ctx, { asOf: "2026-05-15" }));
    assertEq(money(r.totals.days31to60).toFixed(2), "500.00", "bucket");
    assertEq(money(r.totals.total).toFixed(2), "500.00", "total");
    assertEq(r.parties[0].documents[0].daysPastDue, 45, "days");
  });

  await check("as of before the first payment, the full 1500 is current", async () => {
    const r = await t.run(owner, (ctx) => arAging(ctx, { asOf: "2026-03-10" }));
    assertEq(money(r.totals.current).toFixed(2), "1500.00", "current");
  });

  section("Agents");
  await check("a draft-autonomy agent's invoice waits as a draft; posting is refused", async () => {
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: t.org.id, name: "Billing bot", role: "bookkeeper", autonomy: "draft" })
      .returning();
    const actor: Actor = {
      ...bookkeeper,
      kind: "agent",
      userId: null,
      agentId: agent.id,
      agentName: agent.name,
      scopes: ["read", "write"],
      channel: "mcp",
    };
    const inv = await t.run(actor, (ctx) =>
      invoices.createInvoice(ctx, { customerId, invoiceDate: "2026-04-01", lines: [{ itemId: consultingId }] })
    );
    assertEq(inv.status, "draft", "status");
    assertEq(inv.createdByAgentId, agent.id, "createdByAgentId");
    await expectError(() => t.run(actor, (ctx) => invoices.postInvoice(ctx, { id: inv.id })), "forbidden");
    // Asking to post anyway keeps the draft and says it needs review.
    const asked = await t.run(actor, (ctx) =>
      invoices.createInvoice(ctx, { customerId, invoiceDate: "2026-04-01", lines: [{ itemId: consultingId }], post: true })
    );
    assertEq(asked.status, "draft", "kept as draft");
    assert(asked.review?.required, "review notice");
    await t.run(owner, (ctx) => invoices.deleteDraftInvoice(ctx, { id: asked.id }));
    // A human posts it from the review queue.
    const posted = await t.run(bookkeeper, (ctx) => invoices.postInvoice(ctx, { id: inv.id }));
    assertEq(posted.status, "open", "posted by human");
  });

  await check("draft invoices can be deleted; first payment untouched", async () => {
    const inv = await t.run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId, invoiceDate: "2026-04-02", lines: [{ itemId: widgetId }] })
    );
    await t.run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: inv.id }));
    await expectError(() => t.run(owner, (ctx) => invoices.getInvoice(ctx, { id: inv.id })), "not_found");
    const p = await t.run(owner, (ctx) => payments.getCustomerPayment(ctx, { id: firstPaymentId }));
    assertEq(p.status, "posted", "first payment");
  });

  section("Ledger");
  await check("trial balance still balances", async () => {
    const tb = await getTrialBalance(t.org.id, { asOfDate: "2026-12-31" });
    const d = sumMoney(tb.map((r) => r.totalDebit));
    const c = sumMoney(tb.map((r) => r.totalCredit));
    assert(d.eq(c), `debits ${d.toFixed(2)} ≠ credits ${c.toFixed(2)}`);
    const arRow = tb.find((r) => r.accountId === ar.id)!;
    // 1500 invoice − 1000 − 500 paid + 500 voided payment + 150 agent invoice
    assertEq(arRow.netDebit.toFixed(2), "650.00", "AR balance");
  });

  await deleteOrgs("ar-test-");
  void sql;
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
