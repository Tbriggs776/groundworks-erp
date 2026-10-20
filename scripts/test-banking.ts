/**
 * End-to-end: banking. Expenses, checks, deposits (incl. Undeposited
 * Funds), transfers, voids; statement import (CSV + OFX, duplicates);
 * For review (match, add, exclude, undo); bank rules (suggest, auto-add);
 * reconciliation (bank and credit card, complete, undo); the register;
 * and the role / scope / agent rules.
 *
 *   npx tsx scripts/test-banking.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { glLineClearings, glLines, bankStatementLines } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import * as invoices from "../src/lib/ar/invoices";
import * as payments from "../src/lib/ar/payments";
import * as txns from "../src/lib/banking/transactions";
import * as review from "../src/lib/banking/review";
import * as rules from "../src/lib/banking/rules";
import * as rec from "../src/lib/banking/reconcile";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import { money } from "../src/lib/money";
import { listReviewQueue } from "../src/lib/review";
import * as parties from "../src/lib/parties/service";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

async function main() {
  const t = await createTestOrg("bank-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const checking = account(t, "1010");
  const card = account(t, "2100");
  const uf = account(t, "1250");
  const ownerInvestment = account(t, "3100");
  const rent = account(t, "6600");
  const supplies = account(t, "6620");
  const software = account(t, "6250");
  const fees = account(t, "6100");
  const meals = account(t, "6400");
  const otherIncome = account(t, "4900");
  const interest = account(t, "4910");
  const services = account(t, "4100");

  /** Σ debit − credit on an account (base currency, posted ledger). */
  const glBalance = async (accountId: string) => {
    const [r] = await db.execute<{ b: string }>(sql`
      SELECT coalesce(sum(l.debit_local - l.credit_local), 0) AS b FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
       WHERE l.account_id = ${accountId} AND j.status IN ('posted', 'reversed')`);
    return money(r.b);
  };
  const bankSideLine = async (journalId: string, accountId: string) => {
    const [l] = await db.select({ id: glLines.id }).from(glLines).where(and(eq(glLines.journalId, journalId), eq(glLines.accountId, accountId)));
    return l.id;
  };

  const vendor = await run(owner, (ctx) => parties.createVendor(ctx, { name: "Landlord LLC" }));
  const customer = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Bright Harbor" }));

  section("Deposits, expenses, checks, transfers");
  let investment!: txns.BankTransactionDetail;
  await check("owner's investment deposit posts Dr Checking / Cr Owner's Investment", async () => {
    investment = await run(bookkeeper, (ctx) =>
      txns.createDeposit(ctx, { txnDate: "2026-03-01", bankAccountId: checking.id, lines: [{ accountId: ownerInvestment.id, amount: "10000" }], memo: "Startup capital", post: true })
    );
    assertEq(investment.status, "posted", "status");
    assert(investment.txnNumber.startsWith("DEP-"), investment.txnNumber);
    assertEq((await glBalance(checking.id)).toFixed(2), "10000.00", "checking");
    assertEq((await glBalance(ownerInvestment.id)).toFixed(2), "-10000.00", "equity");
  });

  let rentExp!: txns.BankTransactionDetail;
  await check("rent expense to a vendor posts Dr Rent / Cr Checking", async () => {
    rentExp = await run(bookkeeper, (ctx) =>
      txns.createExpense(ctx, { txnDate: "2026-03-02", bankAccountId: checking.id, vendorId: vendor.id, lines: [{ accountId: rent.id, amount: "2000" }], post: true })
    );
    assertEq(rentExp.payee, "Landlord LLC", "payee");
    assertEq((await glBalance(rent.id)).toFixed(2), "2000.00", "rent");
    assertEq((await glBalance(checking.id)).toFixed(2), "8000.00", "checking");
  });

  let check1001!: txns.BankTransactionDetail;
  await check("a check with a refund line nets: Dr 200, Cr 50, Cr Checking 150", async () => {
    check1001 = await run(bookkeeper, (ctx) =>
      txns.createExpense(ctx, {
        type: "check",
        txnDate: "2026-03-03",
        bankAccountId: checking.id,
        payeeName: "Office Mart",
        reference: "1001",
        lines: [
          { accountId: supplies.id, amount: "200" },
          { accountId: supplies.id, amount: "-50", description: "returned toner" },
        ],
        post: true,
      })
    );
    assertEq(money(check1001.totalAmount).toFixed(2), "150.00", "total");
    assertEq(check1001.method, "check", "method defaults to check");
    assertEq((await glBalance(supplies.id)).toFixed(2), "150.00", "supplies");
    assertEq((await glBalance(checking.id)).toFixed(2), "7850.00", "checking");
  });

  let cardPayment!: txns.BankTransactionDetail;
  await check("credit card charge, then paying the card with a transfer", async () => {
    await run(bookkeeper, (ctx) =>
      txns.createExpense(ctx, { txnDate: "2026-03-04", bankAccountId: card.id, payeeName: "SaaSCo", lines: [{ accountId: software.id, amount: "99" }], post: true })
    );
    assertEq((await glBalance(card.id)).toFixed(2), "-99.00", "card owed");
    cardPayment = await run(bookkeeper, (ctx) =>
      txns.createTransfer(ctx, { txnDate: "2026-03-05", fromAccountId: checking.id, toAccountId: card.id, amount: "99", memo: "Card payment", post: true })
    );
    assert(cardPayment.txnNumber.startsWith("XFER-"), cardPayment.txnNumber);
    assertEq((await glBalance(card.id)).toFixed(2), "0.00", "card paid off");
    assertEq((await glBalance(checking.id)).toFixed(2), "7751.00", "checking");
  });

  await check("bad inputs are refused with clear errors", async () => {
    const ar = account(t, "1200");
    await expectError(() => run(bookkeeper, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-06", bankAccountId: checking.id, lines: [{ accountId: ar.id, amount: "5" }] })), "invalid_input");
    await expectError(() => run(bookkeeper, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-06", bankAccountId: checking.id, lines: [{ accountId: checking.id, amount: "5" }] })), "invalid_input");
    await expectError(() => run(bookkeeper, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-06", bankAccountId: checking.id, lines: [{ accountId: rent.id, amount: "-5" }] })), "invalid_input");
    await expectError(() => run(bookkeeper, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-06", bankAccountId: rent.id, lines: [{ accountId: supplies.id, amount: "5" }] })), "invalid_input");
    await expectError(() => run(bookkeeper, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-06", bankAccountId: checking.id, vendorId: vendor.id, customerId: customer.id, lines: [{ accountId: rent.id, amount: "5" }] })), "invalid_input");
    await expectError(() => run(bookkeeper, (ctx) => txns.createTransfer(ctx, { txnDate: "2026-03-06", fromAccountId: checking.id, toAccountId: checking.id, amount: "5" })), "invalid_input");
  });

  section("Undeposited Funds");
  let paymentId = "";
  await check("a received payment waits in Undeposited Funds, then a deposit moves it (plus interest) into Checking", async () => {
    const inv = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: customer.id, invoiceDate: "2026-03-06", lines: [{ description: "Consulting", quantity: 1, unitPrice: "500", accountId: services.id }], post: true })
    );
    const pay = await run(bookkeeper, (ctx) =>
      payments.createCustomerPayment(ctx, { customerId: customer.id, paymentDate: "2026-03-07", method: "check", reference: "778", applications: [{ invoiceId: inv.id, amount: "500" }], post: true })
    );
    paymentId = pay.id;
    const waiting = await run(viewer, (ctx) => txns.listUndepositedPayments(ctx));
    assert(waiting.some((p) => p.id === pay.id), "listed as undeposited");
    const dep = await run(bookkeeper, (ctx) =>
      txns.createDeposit(ctx, { txnDate: "2026-03-08", bankAccountId: checking.id, paymentIds: [pay.id], lines: [{ accountId: interest.id, amount: "5" }], post: true })
    );
    assertEq(money(dep.totalAmount).toFixed(2), "505.00", "total");
    assertEq(dep.lines[0].paymentNumber, pay.paymentNumber, "payment line");
    assertEq((await glBalance(uf.id)).toFixed(2), "0.00", "UF emptied");
    assertEq((await glBalance(checking.id)).toFixed(2), "8256.00", "checking");
    assert(!(await run(viewer, (ctx) => txns.listUndepositedPayments(ctx))).some((p) => p.id === pay.id), "no longer waiting");
  });
  await check("the same payment can't be deposited twice", async () => {
    await expectError(() => run(bookkeeper, (ctx) => txns.createDeposit(ctx, { txnDate: "2026-03-09", bankAccountId: checking.id, paymentIds: [paymentId] })), "invalid_state");
  });

  section("Void, delete, roles, agents");
  await check("only admins void; voiding reverses the ledger", async () => {
    await expectError(() => run(bookkeeper, (ctx) => txns.voidBankTransaction(ctx, { id: rentExp.id, reason: "wrong account" })), "forbidden");
    const v = await run(admin, (ctx) => txns.voidBankTransaction(ctx, { id: rentExp.id, reason: "wrong account" }));
    assertEq(v.status, "voided", "status");
    assertEq((await glBalance(rent.id)).toFixed(2), "0.00", "rent reversed");
    assertEq((await glBalance(checking.id)).toFixed(2), "10256.00", "checking restored");
  });
  await check("drafts can be deleted; posted ones can't", async () => {
    const draft = await run(bookkeeper, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-10", bankAccountId: checking.id, lines: [{ accountId: supplies.id, amount: "12" }] }));
    assertEq(draft.status, "draft", "draft");
    await run(bookkeeper, (ctx) => txns.deleteDraftBankTransaction(ctx, { id: draft.id }));
    await expectError(() => run(bookkeeper, (ctx) => txns.getBankTransaction(ctx, { id: draft.id })), "not_found");
    await expectError(() => run(bookkeeper, (ctx) => txns.deleteDraftBankTransaction(ctx, { id: check1001.id })), "invalid_state");
  });
  await check("viewers read but don't write", async () => {
    const list = await run(viewer, (ctx) => txns.listBankTransactions(ctx, { bankAccountId: checking.id }));
    assert(list.data.length >= 4, `listed ${list.data.length}`);
    await expectError(() => run(viewer, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-10", bankAccountId: checking.id, lines: [{ accountId: supplies.id, amount: "1" }] })), "forbidden");
  });
  await check("a posting agent posts under its limit; over it the draft waits for review", async () => {
    const agentKey = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Bank bot", autonomy: "post", maxPostAmount: "100" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const agent = await authenticateApiKey(agentKey, "api");
    const small = await run(agent, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-11", bankAccountId: checking.id, lines: [{ accountId: supplies.id, amount: "40" }], post: true }));
    assertEq(small.status, "posted", "under limit");
    const big = await run(agent, (ctx) => txns.createExpense(ctx, { txnDate: "2026-03-11", bankAccountId: checking.id, lines: [{ accountId: supplies.id, amount: "400" }], post: true }));
    assertEq(big.status, "draft", "over limit stays draft");
    assert(big.review?.required, "review notice");
    const queue = await run(owner, (ctx) => listReviewQueue(ctx));
    assert(queue.some((q) => q.type === "bank_transaction" && q.id === big.id), "the held draft is in the review queue");
    await run(owner, (ctx) => txns.deleteDraftBankTransaction(ctx, { id: big.id }));
    await run(admin, (ctx) => txns.voidBankTransaction(ctx, { id: small.id, reason: "test cleanup" }));
  });

  section("Statement import");
  const csv = [
    "Date,Description,Amount,Check Number",
    "03/01/2026,ONLINE TRANSFER FROM SAVINGS,10000.00,",
    "03/03/2026,CHECK,-150.00,1001",
    "03/05/2026,PAYMENT TO CARD,-99.00,",
    "03/08/2026,DEPOSIT,505.00,",
    "03/12/2026,COFFEE HOUSE,-4.50,",
    "03/12/2026,COFFEE HOUSE,-4.50,",
    "03/15/2026,MONTHLY SERVICE FEE,-15.00,",
    "03/20/2026,REFUND FROM SUPPLIER,300.00,",
  ].join("\n");
  let firstImport!: review.ImportResult;
  await check("CSV import: 8 lines, identical coffees kept apart, dates and check numbers read", async () => {
    firstImport = await run(bookkeeper, (ctx) => review.importStatement(ctx, { accountId: checking.id, content: csv, fileName: "march.csv" }));
    assertEq(firstImport.format, "csv", "format");
    assertEq(firstImport.newCount, 8, "new");
    assertEq(firstImport.duplicateCount, 0, "dupes");
    const [chk] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.accountId, checking.id), eq(bankStatementLines.reference, "1001")));
    assertEq(chk.postedDate, "2026-03-03", "date");
  });
  await check("re-importing the same file adds nothing", async () => {
    const again = await run(bookkeeper, (ctx) => review.importStatement(ctx, { accountId: checking.id, content: csv }));
    assertEq(again.newCount, 0, "new");
    assertEq(again.duplicateCount, 8, "dupes");
  });
  await check("OFX import reads FITIDs and the ledger balance; imports need a reconcilable account and bookkeeper+", async () => {
    const ofx = `OFXHEADER:100\n<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260325<TRNAMT>-42.00<FITID>OFX-1<NAME>FUEL STOP</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>10500.00<DTASOF>20260331</LEDGERBAL></OFX>`;
    const r = await run(bookkeeper, (ctx) => review.importStatement(ctx, { accountId: checking.id, content: ofx, fileName: "march.ofx", applyRules: false }));
    assertEq(r.format, "ofx", "format");
    assertEq(r.ledgerBalance, "10500.0000", "ledger balance");
    await expectError(() => run(bookkeeper, (ctx) => review.importStatement(ctx, { accountId: uf.id, content: csv })), "invalid_input");
    await expectError(() => run(viewer, (ctx) => review.importStatement(ctx, { accountId: checking.id, content: csv })), "forbidden");
    await expectError(() => run(bookkeeper, (ctx) => review.importStatement(ctx, { accountId: checking.id, content: "just,some\nnonsense,here" })), "invalid_input");
  });

  section("For review: match, add, exclude, undo");
  const lineByDesc = async (desc: string, n = 0) => {
    const page = await run(viewer, (ctx) => review.listStatementLines(ctx, { accountId: checking.id, limit: 200 }));
    return page.data.filter((l) => l.description.startsWith(desc))[n];
  };
  await check("suggested matches line up with what's already in the books", async () => {
    const dep = await lineByDesc("ONLINE TRANSFER FROM SAVINGS");
    assertEq(dep.suggestedMatches[0]?.journalId, investment.glJournalId, "deposit suggestion");
    const chk = await lineByDesc("CHECK");
    assertEq(chk.suggestedMatches[0]?.journalId, check1001.glJournalId, "check suggestion");
    const pay = await lineByDesc("PAYMENT TO CARD");
    assertEq(pay.suggestedMatches[0]?.journalId, cardPayment.glJournalId, "transfer suggestion");
  });
  await check("matching clears the ledger line; wrong totals and reused lines are refused", async () => {
    const dep = await lineByDesc("ONLINE TRANSFER FROM SAVINGS");
    const chk = await lineByDesc("CHECK");
    await expectError(() => run(bookkeeper, (ctx) => review.matchStatementLine(ctx, { id: dep.id, glLineIds: [chk.suggestedMatches[0].glLineId] })), "invalid_input");
    const m = await run(bookkeeper, (ctx) => review.matchStatementLine(ctx, { id: dep.id, glLineIds: [dep.suggestedMatches[0].glLineId] }));
    assertEq(m.status, "matched", "matched");
    const [c] = await db.select().from(glLineClearings).where(eq(glLineClearings.glLineId, dep.suggestedMatches[0].glLineId));
    assertEq(c.status, "cleared", "cleared");
    await run(bookkeeper, (ctx) => review.matchStatementLine(ctx, { id: chk.id, glLineIds: [chk.suggestedMatches[0].glLineId] }));
    const pay = await lineByDesc("PAYMENT TO CARD");
    await run(bookkeeper, (ctx) => review.matchStatementLine(ctx, { id: pay.id, glLineIds: [pay.suggestedMatches[0].glLineId] }));
    const deposit = await lineByDesc("DEPOSIT");
    await run(bookkeeper, (ctx) => review.matchStatementLine(ctx, { id: deposit.id, glLineIds: [deposit.suggestedMatches[0].glLineId] }));
  });
  await check("a rule with auto-add records bank fees at import time, posted and cleared", async () => {
    await expectError(() => run(bookkeeper, (ctx) => rules.createBankRule(ctx, { name: "x", conditions: [{ field: "description", op: "contains", value: "FEE" }], categoryAccountId: fees.id })), "forbidden");
    await run(accountant, (ctx) =>
      rules.createBankRule(ctx, { name: "Bank fees", conditions: [{ field: "description", op: "contains", value: "service fee" }], direction: "money_out", categoryAccountId: fees.id, autoAdd: true })
    );
    const r = await run(bookkeeper, (ctx) => review.applyBankRules(ctx, { accountId: checking.id }));
    assertEq(r.autoAdded, 1, "auto-added");
    assertEq((await glBalance(fees.id)).toFixed(2), "15.00", "fees posted");
    const [line] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.accountId, checking.id), eq(bankStatementLines.description, "MONTHLY SERVICE FEE")));
    assertEq(line.status, "added", "added");
    const txn = await run(viewer, (ctx) => txns.getBankTransaction(ctx, { id: line.bankTransactionId! }));
    const cleared = await db.select().from(glLineClearings).where(eq(glLineClearings.glLineId, await bankSideLine(txn.glJournalId!, checking.id)));
    assertEq(cleared.length, 1, "bank side cleared");
  });
  await check("a rule without auto-add suggests; adding uses it and the line's payee", async () => {
    await run(accountant, (ctx) =>
      rules.createBankRule(ctx, { name: "Coffee", conditions: [{ field: "description", op: "contains", value: "coffee" }, { field: "amount", op: "less_than", value: "20" }], categoryAccountId: meals.id })
    );
    const coffee = await lineByDesc("COFFEE HOUSE");
    assertEq(coffee.suggestedRule?.name, "Coffee", "suggested");
    const added = await run(bookkeeper, (ctx) => review.addStatementLine(ctx, { id: coffee.id }));
    assertEq(added.transaction.status, "posted", "posted");
    assertEq(added.transaction.type, "expense", "expense");
    assertEq((await glBalance(meals.id)).toFixed(2), "4.50", "meals");
  });
  await check("money in, categorized by hand, becomes a deposit", async () => {
    const refund = await lineByDesc("REFUND FROM SUPPLIER");
    const added = await run(bookkeeper, (ctx) => review.addStatementLine(ctx, { id: refund.id, categoryAccountId: otherIncome.id }));
    assertEq(added.transaction.type, "deposit", "deposit");
    assertEq((await glBalance(otherIncome.id)).toFixed(2), "-300.00", "other income");
  });
  await check("exclude, then undo puts it back", async () => {
    const coffee2 = await lineByDesc("COFFEE HOUSE");
    const ex = await run(bookkeeper, (ctx) => review.excludeStatementLine(ctx, { id: coffee2.id }));
    assertEq(ex.status, "excluded", "excluded");
    const back = await run(bookkeeper, (ctx) => review.undoStatementLine(ctx, { id: coffee2.id }));
    assertEq(back.status, "for_review", "restored");
  });
  await check("undoing an added line voids its transaction (admins only)", async () => {
    const [line] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.accountId, checking.id), eq(bankStatementLines.description, "REFUND FROM SUPPLIER")));
    await expectError(() => run(bookkeeper, (ctx) => review.undoStatementLine(ctx, { id: line.id })), "forbidden");
    const back = await run(admin, (ctx) => review.undoStatementLine(ctx, { id: line.id }));
    assertEq(back.status, "for_review", "restored");
    assertEq((await glBalance(otherIncome.id)).toFixed(2), "0.00", "reversed");
    await run(bookkeeper, (ctx) => review.addStatementLine(ctx, { id: line.id, categoryAccountId: otherIncome.id }));
  });

  section("Reconciliation");
  let recId = "";
  await check("only accountants reconcile; the worksheet starts from zero", async () => {
    await expectError(() => run(bookkeeper, (ctx) => rec.startReconciliation(ctx, { accountId: checking.id, statementEndDate: "2026-03-31", statementEndingBalance: "0" })), "forbidden");
    const sheet = await run(accountant, (ctx) =>
      rec.startReconciliation(ctx, { accountId: checking.id, statementEndDate: "2026-03-31", statementEndingBalance: "10551.00" })
    );
    recId = sheet.id;
    assertEq(sheet.beginningBalance, "0.0000", "beginning");
    assert(sheet.lines.length >= 8, `lines ${sheet.lines.length}`);
    await expectError(() => run(accountant, (ctx) => rec.startReconciliation(ctx, { accountId: checking.id, statementEndDate: "2026-04-30", statementEndingBalance: "1" })), "invalid_state");
  });
  await check("ticking what the statement shows brings the difference to zero", async () => {
    // Statement: +10000 −150 −99 +505 −4.50 −15 +300 (one coffee still out, fuel not yet in the books) = 10536.50
    let sheet = await run(accountant, (ctx) => rec.getReconciliation(ctx, { id: recId }));
    const want = (desc: string) => sheet.lines.filter((l) => l.description?.toUpperCase().includes(desc));
    const tick = sheet.lines.filter((l) => !l.cleared && l.amount === "-4.5000").map((l) => l.glLineId);
    if (tick.length) sheet = await run(accountant, (ctx) => rec.setCleared(ctx, { id: recId, glLineIds: tick.slice(0, 1), cleared: true }));
    assert(want("COFFEE").length >= 1, "coffee present");
    // Voided entries stay outstanding: their reversals are dated today, after this statement.
    assert(sheet.lines.some((l) => !l.cleared && l.amount === "-2000.0000"), "voided rent still outstanding");
    const expected = money("10000").minus(150).minus(99).plus(505).minus(4.5).minus(15).plus(300);
    assertEq(sheet.clearedBalance, expected.toFixed(4), "cleared balance");
    await expectError(() => run(accountant, (ctx) => rec.completeReconciliation(ctx, { id: recId })), "invalid_input");
  });
  await check("a statement balance that agrees completes it; the lines become reconciled", async () => {
    await expectError(() => run(bookkeeper, (ctx) => rec.updateReconciliation(ctx, { id: recId, statementEndingBalance: "10536.50" })), "forbidden");
    const fixed = await run(accountant, (ctx) => rec.updateReconciliation(ctx, { id: recId, statementEndingBalance: "10536.50" }));
    assertEq(fixed.difference, "0.0000", "difference after fixing the typo");
    const done = await run(accountant, (ctx) => rec.completeReconciliation(ctx, { id: recId }));
    assertEq(done.status, "completed", "completed");
    const [r] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM gl_line_clearings WHERE reconciliation_id = ${recId} AND status = 'reconciled'`);
    assertEq(r.n, 7, "reconciled");
  });
  await check("a reconciled transaction can't be voided, and its line can't be unmatched", async () => {
    await expectError(() => run(admin, (ctx) => txns.voidBankTransaction(ctx, { id: check1001.id, reason: "x" })), "invalid_state");
    const [line] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.accountId, checking.id), eq(bankStatementLines.reference, "1001")));
    await expectError(() => run(admin, (ctx) => review.undoStatementLine(ctx, { id: line.id })), "invalid_state");
  });
  await check("the next reconciliation starts from the reconciled balance; the report shows what's outstanding", async () => {
    await expectError(() => run(accountant, (ctx) => rec.startReconciliation(ctx, { accountId: checking.id, statementEndDate: "2026-03-15", statementEndingBalance: "1" })), "invalid_input");
    const next = await run(accountant, (ctx) => rec.startReconciliation(ctx, { accountId: checking.id, statementEndDate: "2026-04-30", statementEndingBalance: "10536.50" }));
    assertEq(next.beginningBalance, "10536.5000", "beginning");
    await run(accountant, (ctx) => rec.cancelReconciliation(ctx, { id: next.id }));
    const report = await run(viewer, (ctx) => rec.getReconciliationReport(ctx, { id: recId }));
    assertEq(report.reconciled.length, 7, "reconciled lines");
    assert(report.uncleared.every((l) => l.date <= "2026-03-31"), "uncleared in range");
  });
  await check("only admins undo, and only the latest; lines go back to cleared", async () => {
    await expectError(() => run(accountant, (ctx) => rec.undoReconciliation(ctx, { id: recId, reason: "redo" })), "forbidden");
    const u = await run(admin, (ctx) => rec.undoReconciliation(ctx, { id: recId, reason: "redo" }));
    assertEq(u.status, "undone", "undone");
    const [r] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM gl_line_clearings WHERE reconciliation_id = ${recId} AND status = 'reconciled'`);
    assertEq(r.n, 0, "none reconciled");
  });
  await check("credit card reconciles in its natural sign (owed is positive)", async () => {
    await run(bookkeeper, (ctx) =>
      txns.createExpense(ctx, { txnDate: "2026-03-20", bankAccountId: card.id, payeeName: "Airline", lines: [{ accountId: account(t, "6050").id, amount: "350" }], post: true })
    );
    const sheet = await run(accountant, (ctx) => rec.startReconciliation(ctx, { accountId: card.id, statementEndDate: "2026-03-31", statementEndingBalance: "350" }));
    const charge = sheet.lines.find((l) => l.amount === "350.0000");
    assert(charge, "charge shows as +350 (adds to what's owed)");
    const all = sheet.lines.map((l) => l.glLineId);
    const done = await run(accountant, async (ctx) => {
      await rec.setCleared(ctx, { id: sheet.id, glLineIds: all, cleared: true });
      return rec.completeReconciliation(ctx, { id: sheet.id });
    });
    assertEq(done.clearedBalance, "350.0000", "owed 350");
  });

  section("Overview and register");
  await check("overview: book balance, cleared balance, and what's waiting for review", async () => {
    const all = await run(viewer, (ctx) => rec.listBankAccountsOverview(ctx));
    const chk = all.find((a) => a.id === checking.id)!;
    assertEq(chk.bookBalance, (await glBalance(checking.id)).toFixed(4), "book");
    assert(chk.forReview >= 1, "for review");
    assertEq(all.find((a) => a.id === card.id)!.bookBalance, "350.0000", "card owed");
  });
  await check("register: newest first, running balance, cleared state, and source documents", async () => {
    const reg = await run(viewer, (ctx) => rec.getAccountRegister(ctx, { accountId: checking.id, limit: 200 }));
    assertEq(reg.data[0].balance, (await glBalance(checking.id)).toFixed(4), "running balance ends at book balance");
    assert(reg.data.some((r) => r.source.type === "customer_payment") === false, "the payment went to UF, not checking");
    assert(reg.data.some((r) => r.source.type === "bank_transaction"), "bank documents");
    assert(reg.data.some((r) => r.clearing === "cleared"), "cleared lines marked");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
