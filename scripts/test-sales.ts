/**
 * End-to-end: sales tax (agencies, single and combined rates, exempt
 * customers, the liability report, paying an agency), sales receipts
 * (and depositing them), credit memos (auto-applied, by hand, voided),
 * overpayments as credits, refunds (items and credit), AR aging with
 * credits, and the role / agent rules.
 *
 *   npx tsx scripts/test-sales.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { glLines } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as credits from "../src/lib/ar/credits";
import * as memos from "../src/lib/ar/credit-memos";
import * as invoices from "../src/lib/ar/invoices";
import * as itemsSvc from "../src/lib/ar/items";
import * as payments from "../src/lib/ar/payments";
import * as refunds from "../src/lib/ar/refunds";
import * as receipts from "../src/lib/ar/sales-receipts";
import * as settings from "../src/lib/ar/settings";
import * as txns from "../src/lib/banking/transactions";
import { money, sumMoney } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import { arAging } from "../src/lib/reports/aging";
import { listReviewQueue } from "../src/lib/review";
import * as liability from "../src/lib/sales-tax/liability";
import * as rates from "../src/lib/sales-tax/rates";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

async function main() {
  const t = await createTestOrg("sales-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const checking = account(t, "1010");
  const uf = account(t, "1250");
  const ar = account(t, "1200");
  const taxPayable = account(t, "2200");
  const sales = account(t, "4000");
  const servicesIncome = account(t, "4100");

  const glBalance = async (accountId: string) => {
    const [r] = await db.execute<{ b: string }>(sql`
      SELECT coalesce(sum(l.debit_local - l.credit_local), 0) AS b FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
       WHERE l.account_id = ${accountId} AND j.status IN ('posted', 'reversed')`);
    return money(r.b).toFixed(2);
  };
  const journalSide = async (journalId: string, accountId: string, side: "debit" | "credit") => {
    const rows = await db.select().from(glLines).where(and(eq(glLines.journalId, journalId), eq(glLines.accountId, accountId)));
    return sumMoney(rows.map((r) => r[side])).toFixed(2);
  };

  const widget = await run(owner, (ctx) => itemsSvc.createItem(ctx, { name: "Widget", type: "non_inventory", salesPrice: "100", incomeAccountId: sales.id }));
  const consulting = await run(owner, (ctx) =>
    itemsSvc.createItem(ctx, { name: "Consulting", salesPrice: "50", incomeAccountId: servicesIncome.id, taxable: false })
  );
  const acme = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Acme Retail" }));
  const school = await run(owner, (ctx) =>
    parties.createCustomer(ctx, { name: "Lincoln School", taxExempt: true, taxExemptReason: "Government" })
  );

  section("Sales tax setup");
  let agency!: Awaited<ReturnType<typeof rates.createTaxAgency>>;
  let county!: Awaited<ReturnType<typeof rates.createTaxAgency>>;
  let phoenix!: rates.TaxRateRow;
  let stateRate!: rates.TaxRateRow;
  await check("accountants add agencies (2200 by default) and rates; bookkeepers can't", async () => {
    await expectError(() => run(bookkeeper, (ctx) => rates.createTaxAgency(ctx, { name: "Nope" })), "forbidden");
    agency = await run(accountant, (ctx) => rates.createTaxAgency(ctx, { name: "Arizona DOR", filingFrequency: "quarterly" }));
    assertEq(agency.liabilityAccountId, taxPayable.id, "default liability account");
    county = await run(accountant, (ctx) => rates.createTaxAgency(ctx, { name: "Maricopa County" }));
    await expectError(() => run(accountant, (ctx) => rates.createTaxAgency(ctx, { name: "Bad", liabilityAccountId: sales.id })), "invalid_input");
    stateRate = await run(accountant, (ctx) => rates.createTaxRate(ctx, { name: "AZ State", agencyId: agency.id, ratePercent: "5.6" }));
    const countyRate = await run(accountant, (ctx) => rates.createTaxRate(ctx, { name: "Maricopa", agencyId: county.id, ratePercent: "0.7" }));
    const city = await run(accountant, (ctx) => rates.createTaxRate(ctx, { name: "Phoenix City", agencyId: agency.id, ratePercent: "2.3" }));
    phoenix = await run(accountant, (ctx) => rates.createTaxRate(ctx, { name: "Phoenix", componentIds: [stateRate.id, countyRate.id, city.id] }));
    assertEq(phoenix.kind, "combined", "kind");
    assertEq(money(phoenix.ratePercent).toFixed(2), "8.60", "combined %");
    await expectError(() => run(accountant, (ctx) => rates.createTaxRate(ctx, { name: "Half", agencyId: agency.id })), "invalid_input");
  });

  section("Tax on invoices");
  let inv1!: invoices.InvoiceDetail;
  await check("tax is on the taxable total, rounded once, split by component", async () => {
    inv1 = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, {
        customerId: acme.id,
        invoiceDate: "2026-04-01",
        taxCodeId: phoenix.id,
        lines: [{ itemId: widget.id, quantity: "1" }, { itemId: consulting.id }],
        post: true,
      })
    );
    assertEq(money(inv1.subtotalAmount).toFixed(2), "150.00", "subtotal");
    assertEq(money(inv1.taxableAmount).toFixed(2), "100.00", "only the widget is taxable");
    assertEq(money(inv1.taxAmount).toFixed(2), "8.60", "tax");
    assertEq(money(inv1.totalAmount).toFixed(2), "158.60", "total");
    assertEq(inv1.taxLines.length, 3, "three components");
    assertEq(sumMoney(inv1.taxLines.map((l) => l.taxAmount)).toFixed(2), "8.60", "components add up");
    assertEq(await journalSide(inv1.glJournalId!, ar.id, "debit"), "158.60", "Dr AR");
    assertEq(await journalSide(inv1.glJournalId!, taxPayable.id, "credit"), "8.60", "Cr 2200");
  });
  await check("components always add up to the rounded total", async () => {
    for (const price of ["10.05", "1.25", "2.50", "33.33", "0.07", "99.99"]) {
      const inv = await run(bookkeeper, (ctx) =>
        invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-04-02", taxCodeId: phoenix.id, lines: [{ itemId: widget.id, unitPrice: price }] })
      );
      const expected = money(price).times("0.086").toDecimalPlaces(2, 4); // ROUND_HALF_UP
      assertEq(money(inv.taxAmount).toFixed(2), expected.toFixed(2), `tax on ${price}`);
      assertEq(sumMoney(inv.taxLines.map((l) => l.taxAmount)).toFixed(2), expected.toFixed(2), `components on ${price}`);
      await run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: inv.id }));
    }
  });
  await check("exempt customers pay none; the customer's default rate applies when none is given", async () => {
    const exempt = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: school.id, invoiceDate: "2026-04-03", taxCodeId: phoenix.id, lines: [{ itemId: widget.id }], post: true })
    );
    assertEq(money(exempt.taxAmount).toFixed(2), "0.00", "no tax");
    assert(exempt.taxExempt, "flagged exempt");
    assertEq(exempt.taxLines.length, 3, "components kept at zero for the report");
    await run(owner, (ctx) => parties.updateCustomer(ctx, { id: acme.id, defaultTaxCodeId: stateRate.id }));
    const byDefault = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-04-03", lines: [{ itemId: widget.id }] })
    );
    assertEq(byDefault.taxCodeId, stateRate.id, "default rate");
    assertEq(money(byDefault.taxAmount).toFixed(2), "5.60", "5.6%");
    const none = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-04-03", taxCodeId: null, lines: [{ itemId: widget.id }] })
    );
    assertEq(money(none.taxAmount).toFixed(2), "0.00", "null means no tax");
    await run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: byDefault.id }));
    await run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: none.id }));
    await run(owner, (ctx) => parties.updateCustomer(ctx, { id: acme.id, defaultTaxCodeId: null }));
  });
  await check("changing a rate leaves saved documents alone", async () => {
    await run(accountant, (ctx) => rates.updateTaxRate(ctx, { id: stateRate.id, ratePercent: "6" }));
    const again = await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: inv1.id }));
    assertEq(money(again.taxAmount).toFixed(2), "8.60", "unchanged");
    assertEq(money((await run(viewer, (ctx) => rates.getTaxRate(ctx, { id: phoenix.id }))).ratePercent).toFixed(2), "9.00", "combined follows");
    await run(accountant, (ctx) => rates.updateTaxRate(ctx, { id: stateRate.id, ratePercent: "5.6" }));
  });

  section("Sales receipts");
  let receipt!: receipts.SalesReceiptDetail;
  await check("a taxed cash sale posts Dr Undeposited Funds / Cr income, Cr tax", async () => {
    receipt = await run(bookkeeper, (ctx) =>
      receipts.createSalesReceipt(ctx, { receiptDate: "2026-04-05", method: "cash", taxCodeId: phoenix.id, lines: [{ itemId: widget.id, quantity: "2" }], post: true })
    );
    assert(receipt.receiptNumber.startsWith("SR-"), receipt.receiptNumber);
    assertEq(money(receipt.totalAmount).toFixed(2), "217.20", "200 + 17.20");
    assertEq(await journalSide(receipt.glJournalId!, uf.id, "debit"), "217.20", "Dr UF");
    assertEq(await journalSide(receipt.glJournalId!, taxPayable.id, "credit"), "17.20", "Cr tax");
  });
  await check("it waits in Undeposited Funds, deposits like a payment, and can't be voided while deposited", async () => {
    const waiting = await run(viewer, (ctx) => txns.listUndepositedPayments(ctx));
    const row = waiting.find((w) => w.id === receipt.id);
    assertEq(row?.kind, "sales_receipt", "listed");
    const dep = await run(bookkeeper, (ctx) => txns.createDeposit(ctx, { txnDate: "2026-04-06", bankAccountId: checking.id, paymentIds: [receipt.id], post: true }));
    assertEq(money(dep.totalAmount).toFixed(2), "217.20", "deposit total");
    assertEq(await glBalance(uf.id), "0.00", "UF empty");
    const detail = await run(viewer, (ctx) => receipts.getSalesReceipt(ctx, { id: receipt.id }));
    assertEq(detail.depositedOn?.txnNumber, dep.txnNumber, "deposit shown");
    await expectError(() => run(admin, (ctx) => receipts.voidSalesReceipt(ctx, { id: receipt.id, reason: "x" })), "invalid_state");
    await expectError(() => run(bookkeeper, (ctx) => txns.createDeposit(ctx, { txnDate: "2026-04-06", bankAccountId: checking.id, paymentIds: [receipt.id] })), "invalid_state");
  });

  section("Credit memos");
  // Two open invoices for a fresh customer: 100 (due first) and 50.
  const bolt = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Bolt Co", defaultPaymentTermsDays: 30 }));
  const early = await run(bookkeeper, (ctx) =>
    invoices.createInvoice(ctx, { customerId: bolt.id, invoiceDate: "2026-04-01", lines: [{ itemId: widget.id }], post: true })
  );
  const later = await run(bookkeeper, (ctx) =>
    invoices.createInvoice(ctx, { customerId: bolt.id, invoiceDate: "2026-04-10", lines: [{ itemId: consulting.id }], post: true })
  );
  let memo!: memos.CreditMemoDetail;
  await check("a posted credit memo pays down the oldest invoice first (auto-apply on)", async () => {
    memo = await run(bookkeeper, (ctx) =>
      memos.createCreditMemo(ctx, { customerId: bolt.id, memoDate: "2026-04-12", lines: [{ itemId: widget.id, unitPrice: "120" }], post: true })
    );
    assert(memo.memoNumber.startsWith("CM-"), memo.memoNumber);
    assertEq(await journalSide(memo.glJournalId!, ar.id, "credit"), "120.00", "Cr AR");
    assertEq(await journalSide(memo.glJournalId!, sales.id, "debit"), "120.00", "Dr Sales");
    assertEq(memo.uses.length, 2, "two invoices");
    assertEq(memo.status, "applied", "fully used");
    const e = await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: early.id }));
    const l = await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: later.id }));
    assertEq(e.status, "paid", "early paid by credit");
    assertEq(money(l.openBalance).toFixed(2), "30.00", "later has 30 left");
    assertEq(l.credits[0]?.creditNumber, memo.memoNumber, "credit shown on invoice");
  });
  await check("an invoice with credit applied can't be voided until it's unapplied", async () => {
    await expectError(() => run(admin, (ctx) => invoices.voidInvoice(ctx, { id: later.id, reason: "x" })), "invalid_state");
  });
  await check("unapply puts the credit back; apply by hand uses it again", async () => {
    const l = await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: later.id }));
    await run(bookkeeper, (ctx) => credits.unapplyCredit(ctx, { id: l.credits[0].id }));
    const m = await run(viewer, (ctx) => memos.getCreditMemo(ctx, { id: memo.id }));
    assertEq(m.status, "open", "memo open again");
    assertEq(money(m.remaining).toFixed(2), "20.00", "20 free");
    const list = await run(viewer, (ctx) => credits.listCustomerCredits(ctx, { customerId: bolt.id }));
    assertEq(list.length, 1, "one credit listed");
    await expectError(() => run(bookkeeper, (ctx) => credits.applyCredit(ctx, { creditMemoId: memo.id, invoiceId: later.id, amount: "25" })), "invalid_input");
    await run(bookkeeper, (ctx) => credits.applyCredit(ctx, { creditMemoId: memo.id, invoiceId: later.id }));
    assertEq((await run(viewer, (ctx) => memos.getCreditMemo(ctx, { id: memo.id }))).status, "applied", "applied again");
  });
  await check("voiding a credit memo reverses it and reopens the invoices it paid", async () => {
    const v = await run(admin, (ctx) => memos.voidCreditMemo(ctx, { id: memo.id, reason: "issued in error" }));
    assertEq(v.status, "voided", "voided");
    assertEq((await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: early.id }))).status, "open", "early reopened");
    assertEq(money((await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: later.id }))).openBalance).toFixed(2), "50.00", "later full again");
  });
  await check("with auto-apply off (admins only), a credit waits until applied by hand", async () => {
    await expectError(() => run(accountant, (ctx) => settings.updateSalesSettings(ctx, { autoApplyCredits: false })), "forbidden");
    await run(admin, (ctx) => settings.updateSalesSettings(ctx, { autoApplyCredits: false }));
    const m2 = await run(bookkeeper, (ctx) =>
      memos.createCreditMemo(ctx, { customerId: bolt.id, memoDate: "2026-04-15", lines: [{ itemId: consulting.id, unitPrice: "10" }], post: true })
    );
    assertEq(m2.status, "open", "not applied");
    assertEq(m2.uses.length, 0, "no uses");
    await run(admin, (ctx) => settings.updateSalesSettings(ctx, { autoApplyCredits: true }));
  });

  section("Overpayments");
  const zed = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Zed Ltd" }));
  const zInv = await run(bookkeeper, (ctx) =>
    invoices.createInvoice(ctx, { customerId: zed.id, invoiceDate: "2026-05-01", lines: [{ itemId: consulting.id }], post: true })
  );
  let overpay!: payments.CustomerPaymentDetail;
  await check("paying more than is owed leaves a credit that the next invoice uses", async () => {
    overpay = await run(bookkeeper, (ctx) =>
      payments.createCustomerPayment(ctx, { customerId: zed.id, paymentDate: "2026-05-02", method: "check", amount: "80", post: true })
    );
    assertEq(money(overpay.unappliedAmount).toFixed(2), "30.00", "30 unapplied");
    assertEq((await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: zInv.id }))).status, "paid", "first invoice paid");
    assertEq(money((await run(viewer, (ctx) => parties.getCustomer(ctx, { id: zed.id }))).openBalance).toFixed(2), "-30.00", "customer in credit");
    const next = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: zed.id, invoiceDate: "2026-05-05", lines: [{ itemId: consulting.id }], post: true })
    );
    assertEq(money(next.openBalance).toFixed(2), "20.00", "30 of 50 covered by the credit");
    assertEq(next.credits[0]?.automatic, true, "applied automatically");
    assertEq(money((await run(viewer, (ctx) => payments.getCustomerPayment(ctx, { id: overpay.id }))).unappliedAmount).toFixed(2), "0.00", "credit used");
  });

  section("Refunds");
  await check("an items refund with tax posts Dr income, Dr tax / Cr bank", async () => {
    const r = await run(bookkeeper, (ctx) =>
      refunds.createRefund(ctx, {
        kind: "items",
        customerId: acme.id,
        refundDate: "2026-05-10",
        method: "check",
        reference: "2001",
        bankAccountId: checking.id,
        taxCodeId: phoenix.id,
        lines: [{ itemId: widget.id }],
        post: true,
      })
    );
    assert(r.refundNumber.startsWith("RR-"), r.refundNumber);
    assertEq(money(r.totalAmount).toFixed(2), "108.60", "total");
    assertEq(await journalSide(r.glJournalId!, checking.id, "credit"), "108.60", "Cr bank");
    assertEq(await journalSide(r.glJournalId!, taxPayable.id, "debit"), "8.60", "Dr tax");
  });
  let creditRefund!: refunds.RefundDetail;
  let cm3!: memos.CreditMemoDetail;
  await check("a credit refund pays out a credit memo: Dr AR / Cr bank, and the credit is used up", async () => {
    const quiet = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Quiet Co" }));
    cm3 = await run(bookkeeper, (ctx) =>
      memos.createCreditMemo(ctx, { customerId: quiet.id, memoDate: "2026-05-11", lines: [{ itemId: consulting.id, unitPrice: "40" }], post: true })
    );
    assertEq(cm3.status, "open", "nothing to apply to");
    await expectError(
      () => run(bookkeeper, (ctx) => refunds.createRefund(ctx, { kind: "credit", customerId: quiet.id, refundDate: "2026-05-12", method: "check", bankAccountId: checking.id, amount: "50" })),
      "invalid_input"
    );
    creditRefund = await run(bookkeeper, (ctx) =>
      refunds.createRefund(ctx, { kind: "credit", customerId: quiet.id, refundDate: "2026-05-12", method: "check", bankAccountId: checking.id, amount: "40", creditMemoId: cm3.id, post: true })
    );
    assertEq(await journalSide(creditRefund.glJournalId!, ar.id, "debit"), "40.00", "Dr AR");
    assertEq(await journalSide(creditRefund.glJournalId!, checking.id, "credit"), "40.00", "Cr bank");
    const m = await run(viewer, (ctx) => memos.getCreditMemo(ctx, { id: cm3.id }));
    assertEq(m.status, "applied", "used up");
    assertEq(m.uses[0]?.refundId, creditRefund.id, "by the refund");
  });
  await check("a refunded credit memo can't be voided; voiding the refund gives the credit back", async () => {
    await expectError(() => run(admin, (ctx) => memos.voidCreditMemo(ctx, { id: cm3.id, reason: "x" })), "invalid_state");
    const l = await run(viewer, (ctx) => memos.getCreditMemo(ctx, { id: cm3.id }));
    await expectError(() => run(bookkeeper, (ctx) => credits.unapplyCredit(ctx, { id: l.uses[0].id })), "invalid_state");
    await run(admin, (ctx) => refunds.voidRefund(ctx, { id: creditRefund.id, reason: "check lost" }));
    assertEq((await run(viewer, (ctx) => memos.getCreditMemo(ctx, { id: cm3.id }))).status, "open", "credit back");
  });

  section("Sales tax liability and payment");
  await check("collected = invoices + receipts − credit memos − refunds; exempt sales are non-taxable", async () => {
    const rep = await run(viewer, (ctx) => liability.salesTaxLiability(ctx, { from: "2026-04-01", to: "2026-06-30" }));
    const az = rep.agencies.find((a) => a.agencyId === agency.id)!;
    // AZ DOR gets state 5.6 + city 2.3 = 7.9%: on 100 (inv1) + 200 (receipt) − 100 (refund) of taxable sales.
    assertEq(money(az.taxCollected).toFixed(2), "15.80", "7.90 + 15.80 − 7.90");
    const state = az.rates.find((r) => r.name === "AZ State")!;
    assertEq(money(state.taxableSales).toFixed(2), "200.00", "taxable");
    assert(money(state.nonTaxableSales).gte(100), "includes the exempt school sale and the consulting line");
    assertEq(money(az.balanceOwed).toFixed(2), "15.80", "owed");
    assertEq(await glBalance(taxPayable.id), "-17.20", "2200 holds both agencies' tax");
  });
  await check("paying an agency (accountants, post scope) lowers what's owed; voiding restores it", async () => {
    await expectError(
      () => run(bookkeeper, (ctx) => liability.recordTaxPayment(ctx, { agencyId: agency.id, paymentDate: "2026-07-15", periodEnd: "2026-06-30", amount: "15.80", bankAccountId: checking.id })),
      "forbidden"
    );
    const p = await run(accountant, (ctx) =>
      liability.recordTaxPayment(ctx, { agencyId: agency.id, paymentDate: "2026-07-15", periodEnd: "2026-06-30", amount: "15.80", bankAccountId: checking.id })
    );
    assert(p.paymentNumber.startsWith("STP-"), p.paymentNumber);
    const rep = await run(viewer, (ctx) => liability.salesTaxLiability(ctx, { from: "2026-07-01", to: "2026-07-31" }));
    assertEq(money(rep.agencies.find((a) => a.agencyId === agency.id)!.balanceOwed).toFixed(2), "0.00", "paid off");
    await run(admin, (ctx) => liability.voidTaxPayment(ctx, { id: p.id, reason: "wrong account" }));
    const after = await run(viewer, (ctx) => liability.salesTaxLiability(ctx, { from: "2026-07-01", to: "2026-07-31" }));
    assertEq(money(after.agencies.find((a) => a.agencyId === agency.id)!.balanceOwed).toFixed(2), "15.80", "owed again");
  });

  section("Aging, roles, agents");
  await check("AR aging shows unused credits as negative amounts", async () => {
    const aging = await run(viewer, (ctx) => arAging(ctx, { asOf: "2026-05-31" }));
    const bolt2 = aging.parties.find((p) => p.partyId === bolt.id)!;
    const credit = bolt2.documents.find((d) => d.kind === "credit_memo");
    assert(credit && money(credit.openBalance).lt(0), "credit memo listed negative");
  });
  await check("viewers read; an agent in draft mode leaves sales documents for review", async () => {
    await expectError(
      () => run(viewer, (ctx) => receipts.createSalesReceipt(ctx, { receiptDate: "2026-05-01", method: "cash", lines: [{ itemId: widget.id }] })),
      "forbidden"
    );
    const token = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Sales bot", autonomy: "draft" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const agent = await authenticateApiKey(token, "api");
    const r = await run(agent, (ctx) =>
      receipts.createSalesReceipt(ctx, { receiptDate: "2026-05-20", method: "cash", lines: [{ itemId: consulting.id }], post: true })
    );
    assertEq(r.status, "draft", "kept as a draft");
    assert(r.review?.required, "review notice");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(queue.some((q) => q.type === "sales_receipt" && q.id === r.id), "in the review queue");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
