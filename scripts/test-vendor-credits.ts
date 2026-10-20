/**
 * End-to-end: vendor credits (post, apply to bills, unapply, void), vendor
 * refunds (post, void, credit restored), AP aging and vendor balances net
 * of credits, bill pay by credit card, and printed checks (print queue,
 * numbering, reprint, PDF, amount in words), plus the role / agent rules.
 *
 *   npx tsx scripts/test-vendor-credits.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { accounts, apBills, glJournals, glLines, vendorCredits, vendors } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as billPayments from "../src/lib/ap/bill-payments";
import * as bills from "../src/lib/ap/bills";
import * as checks from "../src/lib/ap/checks";
import * as credits from "../src/lib/ap/credits";
import * as vendorCreditsSvc from "../src/lib/ap/vendor-credits";
import * as refunds from "../src/lib/ap/vendor-refunds";
import * as txns from "../src/lib/banking/transactions";
import { LEDGER_STATUSES } from "../src/lib/gl/ledger";
import { money } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import { checksPdf } from "../src/lib/pdf/documents";
import { apAging } from "../src/lib/reports/aging";
import { listReviewQueue } from "../src/lib/review";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

async function main() {
  const t = await createTestOrg("vcred-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const [lumber] = await db
    .insert(vendors)
    .values({
      organizationId: t.org.id,
      code: "V-1",
      name: "Lumber Co",
      addresses: [{ type: "remit", street1: "1 Mill Rd", city: "Boise", state: "ID", zip: "83702" }],
    })
    .returning();
  const [other] = await db.insert(vendors).values({ organizationId: t.org.id, code: "V-2", name: "Other Co" }).returning();

  const checking = account(t, "1010");
  const savings = account(t, "1020");
  const card = account(t, "2100");
  const apControl = account(t, "2000");
  const materials = account(t, "5100");

  const fixed = (v: string | null | undefined) => money(v ?? 0).toFixed(2);
  const linesOf = (journalId: string) => db.select().from(glLines).where(eq(glLines.journalId, journalId));
  const billOf = (id: string) => run(owner, (ctx) => bills.getBill(ctx, { id }));
  const creditOf = (id: string) => run(owner, (ctx) => vendorCreditsSvc.getVendorCredit(ctx, { id }));
  /** AP control balance on the ledger (credit − debit). */
  const apLedger = async () => {
    const [r] = await db
      .select({ v: sql<string>`COALESCE(SUM(${glLines.credit} - ${glLines.debit}), 0)::text` })
      .from(glLines)
      .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
      .where(and(eq(glLines.accountId, apControl.id), eq(glJournals.organizationId, t.org.id), inArray(glJournals.status, [...LEDGER_STATUSES])));
    return fixed(r.v);
  };
  const vendorBalance = async (id: string) => fixed((await run(owner, (ctx) => parties.getVendor(ctx, { id }))).openBalance);
  /** Every vendor's balance together: what the AP control account should hold. */
  const allVendors = async () => money(await vendorBalance(lumber.id)).plus(await vendorBalance(other.id)).toFixed(2);

  const postBill = (vendorId: string, billDate: string, amount: string) =>
    run(owner, async (ctx) => {
      const b = await bills.createBill(ctx, { vendorId, billDate, lines: [{ accountId: materials.id, amount }], submit: true });
      await bills.approveBill(ctx, { id: b.id });
      return bills.postBill(ctx, { id: b.id });
    });

  section("Vendor credits");
  const bill = await postBill(lumber.id, "2026-03-01", "1000");
  let creditId = "";
  await check("post a $300 credit: Dr AP 300 / Cr Materials 300, open with 300 left", async () => {
    const c = await run(owner, (ctx) =>
      vendorCreditsSvc.createVendorCredit(ctx, {
        vendorId: lumber.id,
        creditDate: "2026-03-05",
        vendorReference: "CM-88",
        lines: [{ accountId: materials.id, amount: "300", description: "Returned studs" }],
        post: true,
      })
    );
    creditId = c.id;
    assertEq(c.status, "open", "status");
    assert(c.creditNumber.startsWith("VC-"), c.creditNumber);
    assertEq(fixed(c.remaining), "300.00", "remaining");
    const lines = await linesOf(c.glJournalId!);
    assertEq(fixed(lines.find((l) => l.accountId === apControl.id)?.debit), "300.00", "AP debit");
    assertEq(fixed(lines.find((l) => l.accountId === materials.id)?.credit), "300.00", "materials credit");
  });
  await check("vendor balance and AP aging net the unused credit; both tie to the ledger", async () => {
    assertEq(await vendorBalance(lumber.id), "700.00", "vendor balance");
    assertEq(await apLedger(), "700.00", "AP ledger");
    const aging = await run(viewer, (ctx) => apAging(ctx, { asOf: "2026-03-31" }));
    const row = aging.parties.find((p) => p.partyId === lumber.id)!;
    const credit = row.documents.find((d) => d.kind === "vendor_credit");
    assert(credit && fixed(credit.openBalance) === "-300.00", "credit listed as -300");
    assertEq(fixed(row.buckets.total), "700.00", "vendor total");
  });

  let appId = "";
  await check("apply $200 to the bill: bill 800 open, credit 100 left, no new journal", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(glJournals).where(eq(glJournals.organizationId, t.org.id));
    const app = await run(bookkeeper, (ctx) => credits.applyVendorCredit(ctx, { vendorCreditId: creditId, billId: bill.id, amount: "200" }));
    appId = app.id;
    assertEq(fixed((await billOf(bill.id)).openBalance), "800.00", "bill open");
    assertEq(fixed((await creditOf(creditId)).remaining), "100.00", "credit left");
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(glJournals).where(eq(glJournals.organizationId, t.org.id));
    assertEq(after[0].n, before[0].n, "journal count");
    assertEq(await vendorBalance(lumber.id), "700.00", "vendor balance unchanged");
  });
  await check("guards: more than the credit has, another vendor's bill, a draft bill", async () => {
    await expectError(() => run(owner, (ctx) => credits.applyVendorCredit(ctx, { vendorCreditId: creditId, billId: bill.id, amount: "150" })), "invalid_input");
    const otherBill = await postBill(other.id, "2026-03-02", "50");
    await expectError(() => run(owner, (ctx) => credits.applyVendorCredit(ctx, { vendorCreditId: creditId, billId: otherBill.id })), "not_found");
    const draft = await run(owner, (ctx) => bills.createBill(ctx, { vendorId: lumber.id, billDate: "2026-03-03", lines: [{ accountId: materials.id, amount: "20" }] }));
    await expectError(() => run(owner, (ctx) => credits.applyVendorCredit(ctx, { vendorCreditId: creditId, billId: draft.id })), "invalid_state");
  });

  section("Bill pay by credit card");
  await check("pay the other $800 on the card: Dr AP / Cr Credit Card; bill paid", async () => {
    const p = await run(owner, (ctx) =>
      billPayments.createBillPayment(ctx, {
        vendorId: lumber.id,
        paymentDate: "2026-03-10",
        method: "credit_card",
        bankAccountId: card.id,
        applications: [{ billId: bill.id, amount: "800" }],
        post: true,
      })
    );
    const lines = await linesOf(p.glJournalId!);
    assertEq(fixed(lines.find((l) => l.accountId === card.id)?.credit), "800.00", "card credit");
    assertEq((await billOf(bill.id)).status, "paid", "bill status");
  });
  await check("a card payment can't go in the check print queue", async () => {
    const b = await postBill(lumber.id, "2026-03-11", "10");
    await expectError(
      () =>
        run(owner, (ctx) =>
          billPayments.createBillPayment(ctx, {
            vendorId: lumber.id,
            paymentDate: "2026-03-12",
            method: "check",
            bankAccountId: card.id,
            printLater: true,
            applications: [{ billId: b.id, amount: "10" }],
          })
        ),
      "invalid_input"
    );
  });
  await check("unapply the credit: bill back to posted with 200 open; reapply pays it", async () => {
    await run(bookkeeper, (ctx) => credits.unapplyVendorCredit(ctx, { id: appId }));
    const b = await billOf(bill.id);
    assertEq(b.status, "posted", "status");
    assertEq(fixed(b.openBalance), "200.00", "open");
    assertEq(fixed((await creditOf(creditId)).remaining), "300.00", "credit left");
    const app = await run(bookkeeper, (ctx) => credits.applyVendorCredit(ctx, { vendorCreditId: creditId, billId: bill.id }));
    appId = app.id;
    assertEq(fixed(app.amount), "200.00", "defaults to what the bill owes");
    assertEq((await billOf(bill.id)).status, "paid", "paid again");
  });

  section("Vendor refunds");
  let refundId = "";
  await check("refund more than the credits have is refused", async () => {
    await expectError(
      () =>
        run(owner, (ctx) =>
          refunds.createVendorRefund(ctx, { vendorId: lumber.id, refundDate: "2026-03-20", method: "check", bankAccountId: checking.id, amount: "100.01" })
        ),
      "invalid_input"
    );
  });
  await check("post a $100 refund: Dr Checking / Cr AP; credit fully used", async () => {
    const r = await run(owner, (ctx) =>
      refunds.createVendorRefund(ctx, {
        vendorId: lumber.id,
        refundDate: "2026-03-20",
        method: "check",
        reference: "77001",
        bankAccountId: checking.id,
        amount: "100",
        vendorCreditId: creditId,
        post: true,
      })
    );
    refundId = r.id;
    assertEq(r.status, "posted", "status");
    assert(r.refundNumber.startsWith("VR-"), r.refundNumber);
    const lines = await linesOf(r.glJournalId!);
    assertEq(fixed(lines.find((l) => l.accountId === checking.id)?.debit), "100.00", "bank debit");
    assertEq(fixed(lines.find((l) => l.accountId === apControl.id)?.credit), "100.00", "AP credit");
    const c = await creditOf(creditId);
    assertEq(c.status, "applied", "credit status");
    assertEq(fixed(c.remaining), "0.00", "credit left");
    assertEq(await allVendors(), await apLedger(), "vendor balances tie to the ledger");
  });
  await check("a refunded credit can't be voided; unapplying a refund's use is refused", async () => {
    await expectError(() => run(admin, (ctx) => vendorCreditsSvc.voidVendorCredit(ctx, { id: creditId, reason: "x" })), "invalid_state");
    const uses = (await creditOf(creditId)).uses;
    const refundUse = uses.find((u) => u.vendorRefundId === refundId);
    assert(refundUse, "refund listed among the credit's uses");
    await expectError(() => run(owner, (ctx) => credits.unapplyVendorCredit(ctx, { id: refundUse.applicationId })), "invalid_state");
  });
  await check("void the refund: reversal posted, credit has 100 again", async () => {
    const r = await run(admin, (ctx) => refunds.voidVendorRefund(ctx, { id: refundId, reason: "Bounced" }));
    assertEq(r.status, "voided", "status");
    assert(r.voidGlJournalId, "reversal");
    const c = await creditOf(creditId);
    assertEq(c.status, "open", "credit status");
    assertEq(fixed(c.remaining), "100.00", "credit left");
  });
  await check("void the credit: takes it off the bill, bill owes 200 again", async () => {
    const c = await run(admin, (ctx) => vendorCreditsSvc.voidVendorCredit(ctx, { id: creditId, reason: "Vendor withdrew it" }));
    assertEq(c.status, "voided", "status");
    const b = await billOf(bill.id);
    assertEq(b.status, "posted", "bill status");
    assertEq(fixed(b.openBalance), "200.00", "bill open");
    assertEq(await allVendors(), await apLedger(), "vendor balances tie to the ledger");
  });
  await check("drafts delete; posted ones don't", async () => {
    const c = await run(owner, (ctx) =>
      vendorCreditsSvc.createVendorCredit(ctx, { vendorId: lumber.id, creditDate: "2026-03-25", lines: [{ accountId: materials.id, amount: "5" }] })
    );
    await run(bookkeeper, (ctx) => vendorCreditsSvc.deleteDraftVendorCredit(ctx, { id: c.id }));
    const gone = await db.select().from(vendorCredits).where(eq(vendorCredits.id, c.id));
    assert(gone.length === 0 || gone[0].deletedAt, "deleted");
    await expectError(() => run(owner, (ctx) => vendorCreditsSvc.deleteDraftVendorCredit(ctx, { id: creditId })), "invalid_state");
  });

  section("Printed checks");
  let payId = "";
  let checkTxnId = "";
  await check("print later: refused with a check number or for a non-check", async () => {
    const b = await postBill(lumber.id, "2026-04-01", "250");
    await expectError(
      () =>
        run(owner, (ctx) =>
          billPayments.createBillPayment(ctx, {
            vendorId: lumber.id,
            paymentDate: "2026-04-02",
            method: "check",
            reference: "123",
            bankAccountId: checking.id,
            printLater: true,
            applications: [{ billId: b.id, amount: "250" }],
          })
        ),
      "invalid_input"
    );
    await expectError(
      () =>
        run(owner, (ctx) =>
          billPayments.createBillPayment(ctx, {
            vendorId: lumber.id,
            paymentDate: "2026-04-02",
            method: "ach",
            bankAccountId: checking.id,
            printLater: true,
            applications: [{ billId: b.id, amount: "250" }],
          })
        ),
      "invalid_input"
    );
    const p = await run(owner, (ctx) =>
      billPayments.createBillPayment(ctx, {
        vendorId: lumber.id,
        paymentDate: "2026-04-02",
        method: "check",
        bankAccountId: checking.id,
        printLater: true,
        applications: [{ billId: b.id, amount: "250" }],
        post: true,
      })
    );
    payId = p.id;
  });
  await check("a banking check marked print later joins the queue; drafts don't", async () => {
    const x = await run(owner, (ctx) =>
      txns.createExpense(ctx, {
        type: "check",
        txnDate: "2026-04-03",
        bankAccountId: checking.id,
        payeeName: "City Water",
        printLater: true,
        lines: [{ accountId: materials.id, amount: "1234.56" }],
        post: true,
      })
    );
    checkTxnId = x.id;
    await run(owner, (ctx) =>
      txns.createExpense(ctx, {
        type: "check",
        txnDate: "2026-04-04",
        bankAccountId: checking.id,
        payeeName: "Draft Payee",
        printLater: true,
        lines: [{ accountId: materials.id, amount: "1" }],
      })
    );
    await expectError(
      () =>
        run(owner, (ctx) =>
          txns.createExpense(ctx, {
            type: "expense",
            txnDate: "2026-04-04",
            bankAccountId: checking.id,
            payeeName: "Card swipe",
            printLater: true,
            lines: [{ accountId: materials.id, amount: "1" }],
          })
        ),
      "invalid_input"
    );
    const queue = await run(viewer, (ctx) => checks.listChecksToPrint(ctx, { bankAccountId: checking.id }));
    assertEq(queue.map((q) => q.id).join(","), [payId, checkTxnId].join(","), "queue, oldest first");
    assertEq(queue[0].payee, "Lumber Co", "payee");
  });
  await check("print from 5001: numbers in order, counter moves to 5003, queue empties", async () => {
    await expectError(
      () => run(owner, (ctx) => checks.printChecks(ctx, { bankAccountId: savings.id, firstCheckNumber: 1, checks: [{ kind: "bill_payment", id: payId }] })),
      "invalid_input"
    );
    await expectError(
      () => run(viewer, (ctx) => checks.printChecks(ctx, { bankAccountId: checking.id, firstCheckNumber: 1, checks: [{ kind: "bill_payment", id: payId }] })),
      "forbidden"
    );
    const r = await run(bookkeeper, (ctx) =>
      checks.printChecks(ctx, {
        bankAccountId: checking.id,
        firstCheckNumber: 5001,
        checks: [
          { kind: "bill_payment", id: payId },
          { kind: "check", id: checkTxnId },
        ],
      })
    );
    assertEq(r.checks.map((c) => c.checkNumber).join(","), "5001,5002", "numbers");
    assertEq(r.nextCheckNumber, 5003, "next");
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, checking.id));
    assertEq(acct.nextCheckNumber, 5003, "stored counter");
    const p = await run(owner, (ctx) => billPayments.getBillPayment(ctx, { id: payId }));
    assertEq(p.reference, "5001", "payment check number");
    const x = await run(owner, (ctx) => txns.getBankTransaction(ctx, { id: checkTxnId }));
    assertEq(x.reference, "5002", "banking check number");
    assertEq((await run(owner, (ctx) => checks.listChecksToPrint(ctx, { bankAccountId: checking.id }))).length, 0, "queue empty");
  });
  await check("printing it twice is refused; print again later clears the number", async () => {
    await expectError(
      () => run(owner, (ctx) => checks.printChecks(ctx, { bankAccountId: checking.id, firstCheckNumber: 9000, checks: [{ kind: "check", id: checkTxnId }] })),
      "invalid_state"
    );
    await run(bookkeeper, (ctx) => checks.queueCheck(ctx, { kind: "check", id: checkTxnId }));
    const x = await run(owner, (ctx) => txns.getBankTransaction(ctx, { id: checkTxnId }));
    assertEq(x.reference, null, "number cleared");
    assertEq(x.toPrint, true, "queued");
    const r = await run(bookkeeper, (ctx) => checks.printChecks(ctx, { bankAccountId: checking.id, firstCheckNumber: 5003, checks: [{ kind: "check", id: checkTxnId }] }));
    assertEq(r.checks[0].checkNumber, "5003", "new number");
  });
  await check("the check carries payee, remit address, words, and the bills it pays; drafts don't print", async () => {
    const c = await run(viewer, (ctx) => checks.checkPrint(ctx, { kind: "bill_payment", id: payId }));
    assertEq(c.checkNumber, "5001", "number");
    assertEq(c.payee, "Lumber Co", "payee");
    assertEq(c.payeeAddress.join(" / "), "1 Mill Rd / Boise, ID 83702", "address");
    assertEq(c.stub.length, 1, "stub rows");
    assertEq(fixed(c.stub[0].amount), "250.00", "stub amount");
    const f = await run(viewer, (ctx) =>
      checksPdf(ctx, [
        { kind: "bill_payment", id: payId },
        { kind: "check", id: checkTxnId },
      ])
    );
    assertEq(f.bytes.subarray(0, 5).toString(), "%PDF-", "PDF bytes");
    assertEq(f.fileName, "Checks_5001_5003.pdf", "file name");
    const draft = await run(owner, (ctx) =>
      txns.createExpense(ctx, { type: "check", txnDate: "2026-04-05", bankAccountId: checking.id, payeeName: "Not yet", lines: [{ accountId: materials.id, amount: "3" }] })
    );
    await expectError(() => run(viewer, (ctx) => checks.checkPrint(ctx, { kind: "check", id: draft.id })), "invalid_state");
  });
  await check("amount in words", async () => {
    assertEq(checks.amountInWords("1234.56"), "One thousand two hundred thirty-four and 56/100", "1234.56");
    assertEq(checks.amountInWords("0.5"), "Zero and 50/100", "0.50");
    assertEq(checks.amountInWords("100"), "One hundred and 00/100", "100");
    assertEq(checks.amountInWords("2000017.10"), "Two million seventeen and 10/100", "2000017.10");
    assertEq(checks.amountInWords("90"), "Ninety and 00/100", "90");
  });

  section("Roles and agents");
  await check("viewers can't create; bookkeepers can't post", async () => {
    await expectError(
      () => run(viewer, (ctx) => vendorCreditsSvc.createVendorCredit(ctx, { vendorId: lumber.id, creditDate: "2026-05-01", lines: [{ accountId: materials.id, amount: "1" }] })),
      "forbidden"
    );
    const c = await run(bookkeeper, (ctx) =>
      vendorCreditsSvc.createVendorCredit(ctx, { vendorId: lumber.id, creditDate: "2026-05-01", lines: [{ accountId: materials.id, amount: "1" }] })
    );
    await expectError(() => run(bookkeeper, (ctx) => vendorCreditsSvc.postVendorCredit(ctx, { id: c.id })), "forbidden");
  });
  await check("an agent in draft mode leaves vendor credits and refunds for review", async () => {
    const token = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "AP bot", autonomy: "draft" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const agent = await authenticateApiKey(token, "api");
    const c = await run(agent, (ctx) =>
      vendorCreditsSvc.createVendorCredit(ctx, { vendorId: other.id, creditDate: "2026-05-02", lines: [{ accountId: materials.id, amount: "40" }], post: true })
    );
    assertEq(c.status, "draft", "credit kept as a draft");
    assert(c.review?.required, "credit review notice");
    await run(owner, (ctx) => vendorCreditsSvc.postVendorCredit(ctx, { id: c.id }));
    const r = await run(agent, (ctx) =>
      refunds.createVendorRefund(ctx, { vendorId: other.id, refundDate: "2026-05-03", method: "ach", bankAccountId: checking.id, amount: "40", post: true })
    );
    assertEq(r.status, "draft", "refund kept as a draft");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(queue.some((q) => q.type === "vendor_refund" && q.id === r.id), "refund in the review queue");
  });

  // Paid bills stay paid; the bill's own row never changes after posting.
  await check("bills table untouched by credits (status only)", async () => {
    const [b] = await db.select().from(apBills).where(eq(apBills.id, bill.id));
    assertEq(fixed(b.totalAmount), "1000.00", "total");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
