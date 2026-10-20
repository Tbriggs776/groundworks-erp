/**
 * End-to-end: the company profile and logo (who can change them, what a
 * logo must be), customer-facing PDFs (invoice, estimate, sales receipt,
 * credit memo), and balance forward statements (opening balance, every AR
 * document and void, the running balance, aging, and the tie-out to the
 * ledger).
 *
 *   npx tsx scripts/test-documents.ts
 *   PDF_OUT=/some/dir npx tsx scripts/test-documents.ts   # also save the PDFs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import type { Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as memos from "../src/lib/ar/credit-memos";
import * as estimates from "../src/lib/ar/estimates";
import * as invoices from "../src/lib/ar/invoices";
import * as itemsSvc from "../src/lib/ar/items";
import * as payments from "../src/lib/ar/payments";
import * as refunds from "../src/lib/ar/refunds";
import * as receipts from "../src/lib/ar/sales-receipts";
import * as settings from "../src/lib/ar/settings";
import * as statements from "../src/lib/ar/statements";
import * as profile from "../src/lib/company/profile";
import { money } from "../src/lib/money";
import * as parties from "../src/lib/parties/service";
import * as pdf from "../src/lib/pdf/documents";
import * as rates from "../src/lib/sales-tax/rates";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

const m2 = (v: string) => money(v).toFixed(2);
/** A 1×1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function main() {
  const t = await createTestOrg("documents-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);
  if (process.env.PDF_OUT) mkdirSync(process.env.PDF_OUT, { recursive: true });
  const save = (f: pdf.PdfFile) => {
    if (process.env.PDF_OUT) writeFileSync(join(process.env.PDF_OUT, f.fileName), f.bytes);
  };
  const isPdf = (f: pdf.PdfFile) => f.bytes.subarray(0, 5).toString() === "%PDF-" && f.bytes.length > 1000;

  const checking = account(t, "1010");
  const sales = account(t, "4000");
  const ar = account(t, "1200");
  await run(admin, (ctx) => settings.updateSalesSettings(ctx, { autoApplyCredits: false }));
  const widget = await run(owner, (ctx) => itemsSvc.createItem(ctx, { name: "Widget", type: "non_inventory", salesPrice: "100", incomeAccountId: sales.id }));
  const acme = await run(owner, (ctx) =>
    parties.createCustomer(ctx, {
      name: "Acme Builders",
      email: "ap@acme.test",
      addresses: [{ type: "billing", street1: "100 Main St", city: "Phoenix", state: "AZ", zip: "85004" }],
    })
  );
  const quiet = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Quiet Co" }));
  const agency = await run(accountant, (ctx) => rates.createTaxAgency(ctx, { name: "Arizona DOR" }));
  const az = await run(accountant, (ctx) => rates.createTaxRate(ctx, { name: "Phoenix", agencyId: agency.id, ratePercent: "8.6" }));

  // =========================================================================
  section("Company profile");
  await check("everyone reads it; only admins change it, and every change is audited", async () => {
    const empty = await run(viewer, (ctx) => profile.getCompanyProfile(ctx));
    assertEq(empty.displayName, t.org.name, "defaults to the company name");
    assertEq(empty.hasLogo, false, "no logo yet");
    await expectError(() => run(bookkeeper, (ctx) => profile.updateCompanyProfile(ctx, { phone: "555" })), "forbidden");
    const p = await run(admin, (ctx) =>
      profile.updateCompanyProfile(ctx, {
        legalName: "Briggs Builders LLC",
        address: { street1: "1 Desert Way", city: "Mesa", state: "AZ", zip: "85201", street2: "" },
        phone: "(480) 555 0100",
        email: "billing@briggs.test",
        taxId: "TPT 123456",
        documentFooter: "Thank you. Checks payable to Briggs Builders LLC.",
      })
    );
    assertEq(p.displayName, "Briggs Builders LLC", "legal name");
    assertEq(Object.keys(p.address).sort().join(","), "city,state,street1,zip", "empty parts dropped");
    assertEq(p.address.street1, "1 Desert Way", "street");
    const partial = await run(admin, (ctx) => profile.updateCompanyProfile(ctx, { website: "briggs.test", email: "" }));
    assertEq(partial.phone, "(480) 555 0100", "fields left out stay");
    assertEq(partial.email, null, "an empty email clears it");
    await expectError(() => run(admin, (ctx) => profile.updateCompanyProfile(ctx, { email: "not an email" })), "invalid_input");
    const [audits] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log WHERE organization_id = ${t.org.id} AND event = 'settings.company_profile.updated'`);
    assertEq(audits.n, 2, "audited");
  });
  await check("a logo must be a real PNG or JPEG under 512 KB", async () => {
    await expectError(() => run(bookkeeper, (ctx) => profile.setCompanyLogo(ctx, { contentType: "image/png", base64: PNG })), "forbidden");
    await expectError(
      () => run(admin, (ctx) => profile.setCompanyLogo(ctx, { contentType: "image/png", base64: Buffer.from("<svg/>").toString("base64") })),
      "invalid_input"
    );
    await expectError(() => run(admin, (ctx) => profile.setCompanyLogo(ctx, { contentType: "image/jpeg", base64: PNG })), "invalid_input");
    const big = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(600 * 1024)]).toString("base64");
    await expectError(() => run(admin, (ctx) => profile.setCompanyLogo(ctx, { contentType: "image/png", base64: big })), "invalid_input");
    const p = await run(admin, (ctx) => profile.setCompanyLogo(ctx, { contentType: "image/png", base64: PNG }));
    assert(p.hasLogo && p.logoBytes > 0, "logo saved");
    assert(!("logoData" in p), "the bytes aren't in the profile view");
  });

  // =========================================================================
  section("Document PDFs");
  let inv1!: invoices.InvoiceDetail;
  await check("an invoice PDF renders with the letterhead and logo", async () => {
    inv1 = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, {
        customerId: acme.id,
        invoiceDate: "2026-02-10",
        dueDate: "2026-03-12",
        taxCodeId: az.id,
        poNumber: "PO-77",
        memo: "Phase 1 materials",
        lines: [{ itemId: widget.id, quantity: "3" }, { accountId: sales.id, description: "Delivery", unitPrice: "45", taxable: false }],
        post: true,
      })
    );
    const f = await run(viewer, (ctx) => pdf.documentPdf(ctx, "invoice", inv1.id));
    assert(isPdf(f), "a PDF");
    assertEq(f.fileName, `Invoice_${inv1.invoiceNumber}.pdf`, "file name");
    save(f);
    const json = pdf.asJson(f);
    assertEq(json.sizeBytes, f.bytes.length, "size");
    assertEq(Buffer.from(json.base64, "base64").subarray(0, 5).toString(), "%PDF-", "base64 round trip");
  });
  await check("estimates, sales receipts, credit memos, drafts and voids all render", async () => {
    const est = await run(bookkeeper, (ctx) =>
      estimates.createEstimate(ctx, { customerId: acme.id, estimateDate: "2026-02-01", expirationDate: "2026-03-01", lines: [{ itemId: widget.id, quantity: "10" }] })
    );
    const sr = await run(bookkeeper, (ctx) =>
      receipts.createSalesReceipt(ctx, { receiptDate: "2026-02-11", method: "cash", lines: [{ itemId: widget.id }], post: true })
    );
    const draft = await run(bookkeeper, (ctx) => invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-02-12", lines: [{ itemId: widget.id }] }));
    // A separate customer, so the statements below stay Acme's alone.
    const doc = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "Doc Co" }));
    const cm = await run(bookkeeper, (ctx) =>
      memos.createCreditMemo(ctx, { customerId: doc.id, memoDate: "2026-02-13", lines: [{ itemId: widget.id }], post: true })
    );
    const voided = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: doc.id, invoiceDate: "2026-02-14", lines: [{ itemId: widget.id }], post: true })
    );
    await run(owner, (ctx) => invoices.voidInvoice(ctx, { id: voided.id, reason: "Test" }));
    for (const [kind, id] of [
      ["estimate", est.id],
      ["sales_receipt", sr.id],
      ["invoice", draft.id],
      ["credit_memo", cm.id],
      ["invoice", voided.id],
    ] as const) {
      const f = await run(viewer, (ctx) => pdf.documentPdf(ctx, kind, id));
      assert(isPdf(f), `${kind} renders`);
      save(f);
    }
    await run(bookkeeper, (ctx) => invoices.deleteDraftInvoice(ctx, { id: draft.id }));
  });
  await check("another company's documents aren't found", async () => {
    const other = await createTestOrg("documents-other-");
    await expectError(() => other.run(other.as("owner"), (ctx) => pdf.documentPdf(ctx, "invoice", inv1.id)), "not_found");
  });

  // =========================================================================
  section("Statements");
  /** The customer's AR balance in the ledger on a date. */
  const ledgerAr = async (customerId: string, asOf: string) => {
    const [r] = await db.execute<{ b: string }>(sql`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
       WHERE l.account_id = ${ar.id} AND l.customer_id = ${customerId}
         AND j.status IN ('posted', 'reversed') AND j.journal_date <= ${asOf}::date`);
    return m2(r.b);
  };
  let st!: statements.Statement;
  await check("balance forward: the opening balance, each document in order, and the closing balance", async () => {
    // inv1 (Feb 10, 344.80) is before the period. In March: an invoice, a
    // payment with a discount, a credit memo, an overpayment refunded, and
    // an invoice voided.
    const inv2 = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-03-05", lines: [{ itemId: widget.id, quantity: "2" }], post: true })
    );
    await run(bookkeeper, (ctx) =>
      payments.createCustomerPayment(ctx, {
        customerId: acme.id,
        paymentDate: "2026-03-10",
        method: "check",
        reference: "1042",
        depositAccountId: checking.id,
        applications: [{ invoiceId: inv1.id, amount: "340", discountAmount: "4.80" }],
        post: true,
      })
    );
    await run(bookkeeper, (ctx) =>
      memos.createCreditMemo(ctx, { customerId: acme.id, memoDate: "2026-03-12", lines: [{ itemId: widget.id, unitPrice: "25" }], post: true })
    );
    const over = await run(bookkeeper, (ctx) =>
      payments.createCustomerPayment(ctx, {
        customerId: acme.id,
        paymentDate: "2026-03-15",
        method: "ach",
        depositAccountId: checking.id,
        amount: "250",
        applications: [{ invoiceId: inv2.id, amount: "200" }],
        post: true,
      })
    );
    await run(bookkeeper, (ctx) =>
      refunds.createRefund(ctx, {
        kind: "credit",
        customerId: acme.id,
        refundDate: "2026-03-18",
        method: "check",
        bankAccountId: checking.id,
        amount: "50",
        paymentId: over.id,
        post: true,
      })
    );
    const inv3 = await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-03-20", lines: [{ itemId: widget.id }], post: true })
    );
    await run(owner, (ctx) => invoices.voidInvoice(ctx, { id: inv3.id, reason: "Internal: wrong customer" }));
    await run(bookkeeper, (ctx) =>
      invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-03-25", dueDate: "2026-03-25", lines: [{ itemId: widget.id, quantity: "4" }], post: true })
    );

    st = await run(viewer, (ctx) => statements.customerStatement(ctx, { id: acme.id, from: "2026-03-01", to: "2026-03-31" }));
    assertEq(m2(st.openingBalance), "370.80", "balance forward = the February invoice with tax");
    const kinds = st.lines.map((l) => l.kind).join(",");
    assertEq(kinds, "invoice,payment,credit_memo,payment,refund,invoice,invoice", "March, in date order");
    const pay = st.lines.find((l) => l.kind === "payment")!;
    assertEq(m2(pay.amount), "-344.80", "payment counts cash and discount");
    assert(pay.description.includes("1042"), "payment shows its reference");
    // 370.80 + 200 − 344.80 − 25 − 250 + 50 + 100 + 400. The void is dated
    // today, after this statement, so INV-3 still counts here.
    assertEq(m2(st.closingBalance), "501.00", "closing balance");
    assertEq(m2(st.lines[st.lines.length - 1].balance), "501.00", "running balance ends at the closing balance");
    assertEq(m2(st.charges), "750.00", "charges: 200 + 50 + 100 + 400");
    assertEq(m2(st.credits), "619.80", "credits: 344.80 + 25 + 250");
    assertEq(await ledgerAr(acme.id, "2026-03-31"), "501.00", "ties to the ledger");
    assertEq(await ledgerAr(acme.id, "2026-02-28"), m2(st.openingBalance), "the opening balance ties too");
    assertEq(st.agingTiesOut, false, "a later void leaves the March aging short, so it's flagged");

    const today = new Date().toISOString().slice(0, 10);
    const now = await run(viewer, (ctx) => statements.customerStatement(ctx, { id: acme.id, from: "2026-03-01", to: today }));
    const voidLine = now.lines[now.lines.length - 1];
    assertEq(voidLine.kind, "void", "the void comes last, on its own date");
    assertEq(m2(voidLine.amount), "-100.00", "it takes the invoice back off");
    assert(voidLine.description.includes(inv3.invoiceNumber), "naming the invoice");
    assert(now.lines.every((l) => !l.description.includes("Internal")), "void reasons never reach the customer");
    assertEq(m2(now.closingBalance), "401.00", "closing balance today");
    assertEq(await ledgerAr(acme.id, today), "401.00", "ties to the ledger today");
    assertEq(now.agingTiesOut, true, "today's aging adds up");
    assertEq(m2(now.aging.total), "401.00", "aging total");
    assert(money(now.aging.over90).gt(0), "the February leftover is over 90 days past due");
  });
  await check("a statement's dates default sensibly and must be in order", async () => {
    const d = await run(viewer, (ctx) => statements.customerStatement(ctx, { id: acme.id }));
    assert(d.from < d.to, "defaults: first of last month to today");
    await expectError(() => run(viewer, (ctx) => statements.customerStatement(ctx, { id: acme.id, from: "2026-04-01", to: "2026-03-01" })), "invalid_input");
  });
  await check("the list shows customers with a balance or activity; PDFs render one or all", async () => {
    const list = await run(viewer, (ctx) => statements.listStatements(ctx, { from: "2026-03-01", to: "2026-03-31" }));
    assert(list.some((s) => s.customer.id === acme.id), "Acme listed");
    assert(!list.some((s) => s.customer.id === quiet.id), "Quiet Co left out");
    const all = await run(viewer, (ctx) => statements.listStatements(ctx, { from: "2026-03-01", to: "2026-03-31", includeZero: true }));
    assert(all.some((s) => s.customer.id === quiet.id), "listed with includeZero");
    const one = await run(viewer, (ctx) => pdf.statementPdf(ctx, { id: acme.id, from: "2026-03-01", to: "2026-03-31" }));
    assert(isPdf(one), "statement PDF");
    save(one);
    const batch = await run(viewer, (ctx) => pdf.statementsPdf(ctx, { from: "2026-03-01", to: "2026-03-31" }));
    assert(batch && isPdf(batch), "batch PDF");
    const none = await run(viewer, (ctx) => pdf.statementsPdf(ctx, { from: "2020-01-01", to: "2020-01-31" }));
    assertEq(none, null, "nothing to print");
  });
  await check("agents can read documents and statements", async () => {
    const token = await run(owner, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Collections bot", autonomy: "draft" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const agent = await authenticateApiKey(token, "api");
    const f = await run(agent, (ctx) => pdf.documentPdf(ctx, "invoice", inv1.id));
    assert(isPdf(f), "agent renders an invoice");
    const s = await run(agent, (ctx) => statements.customerStatement(ctx, { id: acme.id, from: "2026-03-01", to: "2026-03-31" }));
    assertEq(m2(s.closingBalance), m2(st.closingBalance), "same statement");
    await expectError(() => run(agent, (ctx) => profile.updateCompanyProfile(ctx, { phone: "1" })), "forbidden");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
