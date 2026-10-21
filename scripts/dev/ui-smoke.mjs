/**
 * UI smoke test: signs in through a fake Supabase session cookie, loads
 * every main page (fails on any 4xx/5xx, error boundary, or console
 * error, CSP violations included), and clicks through the main flows:
 * create + post an invoice, sales tax (agency, rate, a taxed invoice, a
 * credit memo, a sales receipt, a refund), create an agent + key, approve
 * from the review queue, banking (record an expense, import a statement, match,
 * add, and rule its lines, reconcile, undo), invite someone, add a
 * company and switch to it, AP (a vendor credit and refund, a purchase
 * order billed in part, a recurring bill, the 1099 report, a printed
 * check), save the security policy, complete an access
 * review, export the audit log, set a password, sign out, sign back in
 * with it, ask for a reset link, and sign up a new account with a
 * password.
 *
 * Needs: the app running on :3100 built with
 * NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321, the fake auth server
 * (scripts/dev/fake-supabase-auth.mjs), a seeded org
 * (scripts/dev/seed-demo.ts), and Playwright available:
 *
 *   npx -p playwright node scripts/dev/ui-smoke.mjs <shots-dir> <profile-uuid> <email>
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const [, , outDir, userId, email] = process.argv;
mkdirSync(outDir, { recursive: true });
const BASE = "http://localhost:3100";
// An unsigned HS256-shaped JWT: getClaims() falls back to GET /auth/v1/user
// on the fake auth server, which vouches for it.
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const accessToken = [
  b64({ alg: "HS256", typ: "JWT" }),
  b64({
    sub: userId, email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 * 24,
    session_id: crypto.randomUUID(), aal: "aal1", amr: [{ method: "otp", timestamp: now }],
  }),
  "c2lnbmF0dXJl",
].join(".");
const session = {
  access_token: accessToken,
  token_type: "bearer",
  expires_in: 3600 * 24,
  expires_at: Math.floor(Date.now() / 1000) + 3600 * 24,
  refresh_token: "fake-refresh",
  user: { id: userId, email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} },
};
const cookieValue = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.addCookies([{ name: "sb-localhost-auth-token", value: cookieValue, domain: "localhost", path: "/" }]);
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror on ${page.url()}: ${e.message}`));
// The wrong-password check expects one rejected sign-in request, and the
// staff-only page one 404.
let expectRejectedSignIn = false;
let expect404 = false;
const consoleProblem = (pg) => (m) => {
  if (m.type() !== "error") return;
  if (expectRejectedSignIn && m.location().url.includes("/auth/v1/token")) return;
  if (expect404 && / 404 /.test(m.text())) return;
  problems.push(`console on ${pg.url()}: ${m.text()}`);
};
page.on("console", consoleProblem(page));

async function visit(path, name, signedOut = false) {
  const res = await page.goto(BASE + path, { waitUntil: "networkidle" });
  const status = res?.status();
  const body = await page.locator("body").innerText();
  const bad = status >= 400 || /Application error|Internal Server Error|Unhandled Runtime Error/.test(body) || (!signedOut && page.url().includes("/auth/login"));
  console.log(`${bad ? "✗" : "✓"} ${status} ${path}${page.url() !== BASE + path ? `  -> ${page.url().replace(BASE, "")}` : ""}`);
  if (bad) problems.push(`bad page ${path} (${status}) ${body.slice(0, 200)}`);
  // A dropdown should show the chosen option's label, never its raw id.
  const rawIds = (await page.locator('[role="combobox"]').allInnerTexts()).filter((t) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(t));
  if (rawIds.length) problems.push(`raw id in a dropdown on ${path}: ${rawIds[0]}`);
  if (name) await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

const pages = [
  ["/dashboard", "dashboard"], ["/customers", "customers"], ["/items", "items"],
  ["/ar/invoices", "invoices"], ["/ar/invoices/new", "invoice-new"], ["/ar/payments", null],
  ["/ar/payments/new", "receive-payment"], ["/vendors", null], ["/ap/bills", null], ["/ap/bills/new", null],
  ["/ap/payments", null], ["/accounts", null], ["/gl", null], ["/gl/journals/new", "journal-new"],
  ["/recurring/new", null], ["/allocations/new", null], ["/budgets/new", null], ["/rates", null],
  ["/reports/ar-aging", "ar-aging"],
  ["/reports/ap-aging", null], ["/reports/income-statement", null], ["/reports/balance-sheet", null],
  ["/review", "review"], ["/settings/agents", "agents"], ["/settings/api-keys", "api-keys"],
  ["/activity", "activity"], ["/settings/approval-thresholds", null],
  ["/workspace", "workspace"], ["/workspace/people", "people"], ["/workspace/security", "security-policy"],
  ["/workspace/access-review", "access-review"], ["/workspace/audit", "audit-log"], ["/workspace/companies/new", null],
  ["/account/security", "my-security"], ["/clients", "clients"],
  ["/banking", "banking"], ["/banking/review", null], ["/banking/transactions", null],
  ["/banking/transactions/new?type=expense", "bank-expense-new"], ["/banking/transactions/new?type=check", null],
  ["/banking/transactions/new?type=deposit", "bank-deposit-new"], ["/banking/transactions/new?type=transfer", null],
  ["/banking/rules", null], ["/banking/reconcile", "reconcile-start"], ["/banking/register", null],
  ["/ar/sales-receipts", null], ["/ar/sales-receipts/new", "sales-receipt-new"], ["/ar/credit-memos", null],
  ["/ar/credit-memos/new", null], ["/ar/refunds", null], ["/ar/refunds/new", null], ["/ar/refunds/new?kind=credit", "refund-credit-new"],
  ["/sales-tax", "sales-tax"], ["/settings/sales", null],
  ["/ar/estimates", null], ["/ar/estimates/new", "estimate-new"], ["/ar/recurring", null], ["/ar/recurring/new", "recurring-new"],
  ["/settings/company", "company-profile"], ["/ar/statements", "statements"],
  ["/ap/vendor-credits", null], ["/ap/vendor-credits/new", "vendor-credit-new"], ["/ap/vendor-refunds", null],
  ["/ap/vendor-refunds/new", null], ["/banking/checks", "print-checks"],
  ["/ap/purchase-orders", null], ["/ap/purchase-orders/new", "po-new"],
  ["/ap/recurring", null], ["/ap/recurring/new", "recurring-bill-new"], ["/reports/1099", "report-1099"],
  ["/reports/cash-flow", "cash-flow"], ["/reports/profit-and-loss-by-period", "pnl-by-month"],
  ["/reports/profit-and-loss-by-class", null], ["/reports/budget-vs-actual", null],
  ["/reports/sales-by-customer", "sales-by-customer"], ["/reports/sales-by-item", "sales-by-item"],
  ["/reports/expenses-by-vendor", "expenses-by-vendor"], ["/reports/open-invoices", "open-invoices"],
  ["/reports/unpaid-bills", null], ["/reports/audit-trail", "audit-trail"],
  ["/periods", "close-books"], ["/reports/changes-after-close", null], ["/settings/email", "email-settings"],
  ["/items/adjustments", null], ["/items/adjustments/new", null], ["/settings/inventory", "inventory-settings"],
  ["/reports/inventory-valuation", null], ["/reports/inventory-valuation-detail", "valuation-detail"],
  ["/reports/inventory-stock-status", "stock-status"],
];
for (const [p, n] of pages) await visit(p, n);

// Flow 1: create + post an invoice through the form.
await page.goto(BASE + "/ar/invoices/new", { waitUntil: "networkidle" });
const selects = page.locator("main select");
await selects.nth(0).selectOption({ label: "Northwind Traders" });
await page.locator("tbody select").first().selectOption({ label: "Consulting" });
await page.locator('tbody input[inputmode="decimal"]').first().fill("2");
await page.getByRole("button", { name: "Save and post" }).click();
await page.waitForURL(/\/ar\/invoices\/[0-9a-f-]{36}$/, { timeout: 15000 });
await page.waitForLoadState("networkidle");
const invText = await page.locator("main").innerText();
console.log(/open/i.test(invText) && invText.includes("$300.00") ? "✓ flow: invoice created + posted ($300.00, open)" : "✗ flow: invoice");
if (!(/open/i.test(invText) && invText.includes("$300.00"))) problems.push("invoice flow: " + invText.slice(0, 300));
await page.screenshot({ path: `${outDir}/invoice-detail.png`, fullPage: true });

// Flow S: sales tax, a taxed invoice, a credit memo that pays it down, a
// sales receipt, and a refund.
{
  const stamp = Date.now();
  await page.goto(BASE + "/sales-tax", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Add agency" }).click();
  await page.getByPlaceholder("Arizona Department of Revenue").fill(`Smoke State ${stamp}`);
  await page.getByRole("dialog").getByRole("button", { name: "Add agency" }).click();
  await page.getByText(`Smoke State ${stamp}`).first().waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Add rate" }).click();
  await page.getByRole("dialog").getByPlaceholder("Arizona state").fill(`Smoke 5% ${stamp}`);
  const agencySelect = page.getByRole("dialog").locator("select").first();
  await agencySelect.selectOption({ label: `Smoke State ${stamp}` });
  await page.getByRole("dialog").getByPlaceholder("5.6").fill("5");
  await page.getByRole("dialog").getByRole("button", { name: "Add rate" }).click();
  await page.getByText(`Smoke 5% ${stamp}`).first().waitFor({ timeout: 10000 });
  console.log("✓ flow: sales tax agency and rate added");

  await page.goto(BASE + "/ar/invoices/new", { waitUntil: "networkidle" });
  await page.locator("main select").nth(0).selectOption({ label: "Northwind Traders" });
  await page.getByLabel("Sales tax rate").selectOption({ label: `Smoke 5% ${stamp} (5%)` });
  await page.locator("tbody select").first().selectOption({ label: "Consulting" });
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/ar\/invoices\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const taxed = await page.locator("main").innerText();
  const taxOk = taxed.includes("$157.50") && taxed.toLowerCase().includes(`smoke state ${stamp}`);
  console.log(taxOk ? "✓ flow: invoice with 5% sales tax ($150.00 + $7.50)" : "✗ flow: taxed invoice");
  if (!taxOk) problems.push("taxed invoice: " + taxed.slice(0, 300));
  await page.screenshot({ path: `${outDir}/invoice-taxed.png`, fullPage: true });

  await page.goto(BASE + "/ar/credit-memos/new", { waitUntil: "networkidle" });
  await page.locator("main select").nth(0).selectOption({ label: "Northwind Traders" });
  await page.locator("tbody select").first().selectOption({ label: "Consulting" });
  await page.locator('tbody input[inputmode="decimal"]').nth(1).fill("10");
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/ar\/credit-memos\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Credit used").waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/credit-memo.png`, fullPage: true });
  console.log("✓ flow: credit memo posted and applied to the oldest open invoice");

  await page.goto(BASE + "/ar/sales-receipts/new", { waitUntil: "networkidle" });
  await page.locator("tbody select").first().selectOption({ label: "Consulting" });
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/ar\/sales-receipts\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Posted to the ledger").waitFor({ timeout: 10000 });
  console.log("✓ flow: sales receipt posted into Undeposited Funds");

  await page.goto(BASE + "/ar/refunds/new", { waitUntil: "networkidle" });
  await page.locator("main select").nth(0).selectOption({ label: "Northwind Traders" });
  await page.locator("tbody select").first().selectOption({ label: "Consulting" });
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/ar\/refunds\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Posted to the ledger").waitFor({ timeout: 10000 });
  console.log("✓ flow: refund for returned items posted");

  await visit("/sales-tax", "sales-tax-after");
}

// Flow E: an estimate, accepted, billed 25% by progress invoicing.
{
  await page.goto(BASE + "/ar/estimates/new", { waitUntil: "networkidle" });
  await page.getByLabel("Customer").selectOption({ label: "Northwind Traders" });
  await page.locator("tbody select").first().selectOption({ label: "Consulting" });
  await page.locator('tbody input[inputmode="decimal"]').first().fill("4");
  await page.getByRole("button", { name: "Save estimate" }).click();
  await page.waitForURL(/\/ar\/estimates\/[0-9a-f-]{36}$/, { timeout: 15000 });
  const estimateUrl = page.url();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("dialog").getByPlaceholder("Optional").fill("Smoke buyer");
  await page.getByRole("dialog").getByRole("button", { name: "Accept" }).click();
  await page.getByText("by Smoke buyer").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.getByRole("radio", { name: "A percent of each line" }).click();
  await page.getByRole("dialog").getByLabel("Percent").fill("25");
  await page.getByRole("dialog").getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL(/\/ar\/invoices\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const progress = await page.locator("main").innerText();
  const progressOk = progress.includes("Bills estimate") && progress.includes("$150.00");
  console.log(progressOk ? "✓ flow: estimate accepted and 25% billed ($150.00 of $600.00)" : "✗ flow: progress invoice");
  if (!progressOk) problems.push("progress invoice: " + progress.slice(0, 300));
  await page.getByRole("button", { name: "Post invoice" }).click();
  await page.getByText("Posted to the ledger").waitFor({ timeout: 10000 });
  await page.goto(estimateUrl, { waitUntil: "networkidle" });
  const left = await page.locator("main").innerText();
  const leftOk = /left to bill before tax\s+\$450\.00/i.test(left);
  console.log(leftOk ? "✓ flow: the estimate shows $450.00 left to bill" : "✗ flow: estimate balance");
  if (!leftOk) problems.push("estimate balance: " + left.slice(0, 400));
  await page.screenshot({ path: `${outDir}/estimate-progress.png`, fullPage: true });
}

// Flow R: a recurring invoice template, then an invoice from it now.
{
  const stamp = Date.now();
  await page.goto(BASE + "/ar/recurring/new", { waitUntil: "networkidle" });
  await page.getByPlaceholder("Monthly retainer").fill(`Smoke retainer ${stamp}`);
  await page.getByLabel("Type").selectOption("reminder");
  await page.getByLabel("Customer").selectOption({ label: "Northwind Traders" });
  await page.locator("tbody select").first().selectOption({ label: "Consulting" });
  await page.getByRole("button", { name: "Save template" }).click();
  await page.waitForURL(/\/ar\/recurring\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Next invoice").waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/recurring-detail.png`, fullPage: true });
  await page.getByRole("button", { name: "Create invoice now" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/ar\/invoices\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const fromTemplate = await page.locator("main").innerText();
  const templateOk = fromTemplate.includes(`From recurring invoice Smoke retainer ${stamp}`) && fromTemplate.includes("Make recurring");
  console.log(templateOk ? "✓ flow: recurring template saved and used for a draft invoice" : "✗ flow: recurring invoice");
  if (!templateOk) problems.push("recurring: " + fromTemplate.slice(0, 300));
  await page.getByRole("button", { name: "Delete draft" }).click();
  await page.waitForURL(/\/ar\/invoices$/, { timeout: 15000 });
}

// Flow P: company profile and logo, then the PDFs customers get.
{
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  await page.goto(BASE + "/settings/company", { waitUntil: "networkidle" });
  await page.getByLabel("Phone").fill("(480) 555 0100");
  await page.getByLabel("City").fill("Mesa");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved.").waitFor({ timeout: 10000 });
  await page.getByLabel("Logo file").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.getByText("Logo saved.").waitFor({ timeout: 10000 });
  await page.getByAltText("Company logo").waitFor({ timeout: 10000 });
  console.log("✓ flow: company profile saved and logo uploaded");

  const isPdf = async (path) => {
    const res = await page.request.get(BASE + path);
    const body = await res.body();
    return res.status() === 200 && res.headers()["content-type"] === "application/pdf" && body.subarray(0, 5).toString() === "%PDF-";
  };
  await page.goto(BASE + "/ar/invoices", { waitUntil: "networkidle" });
  const invoiceHref = await page.locator('main a[href^="/ar/invoices/"]').filter({ hasText: /^INV-/ }).first().getAttribute("href");
  await page.goto(BASE + invoiceHref, { waitUntil: "networkidle" });
  const pdfHref = await page.getByRole("link", { name: "PDF" }).getAttribute("href");
  const invoicePdf = await isPdf(pdfHref);
  console.log(invoicePdf ? "✓ flow: invoice PDF downloads" : "✗ flow: invoice PDF");
  if (!invoicePdf) problems.push("invoice PDF " + pdfHref);

  await page.goto(BASE + "/ar/statements", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Northwind Traders" }).click();
  await page.waitForURL(/\/ar\/statements\/[0-9a-f-]{36}/, { timeout: 15000 });
  await page.getByText("Balance forward").first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/statement.png`, fullPage: true });
  const statementHref = await page.getByRole("link", { name: "PDF" }).getAttribute("href");
  const statementPdf = (await isPdf(statementHref)) && (await isPdf("/pdf/statements"));
  console.log(statementPdf ? "✓ flow: statement PDFs download (one customer and all)" : "✗ flow: statement PDFs");
  if (!statementPdf) problems.push("statement PDF " + statementHref);
}

// Flow V: a vendor credit, part of it refunded, then a check printed from
// the print queue.
{
  const stamp = Date.now();
  const vendorName = `Smoke Supply ${stamp}`;
  await page.goto(BASE + "/vendors", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New vendor" }).click();
  await page.getByPlaceholder("ABC Office Supply").fill(vendorName);
  await page.getByRole("dialog").getByRole("button", { name: "Create vendor" }).click();
  await page.getByText(vendorName).first().waitFor({ timeout: 10000 });

  await page.goto(BASE + "/ap/vendor-credits/new", { waitUntil: "networkidle" });
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: vendorName });
  await page.getByLabel("Line 1 account").selectOption({ label: "6200 · Dues & Subscriptions" });
  await page.getByLabel("Line 1 amount").fill("50");
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/ap\/vendor-credits\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Posted to the ledger").waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/vendor-credit.png`, fullPage: true });
  console.log("✓ flow: vendor credit of $50.00 posted");

  await page.goto(BASE + "/ap/vendor-refunds/new", { waitUntil: "networkidle" });
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: vendorName });
  await page.getByLabel("Amount", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/ap\/vendor-refunds\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Posted to the ledger").waitFor({ timeout: 10000 });
  const refund = await page.locator("main").innerText();
  const refundOk = refund.includes("$20.00") && refund.includes("VC-");
  console.log(refundOk ? "✓ flow: vendor refund of $20.00 posted against the credit" : "✗ flow: vendor refund");
  if (!refundOk) problems.push("vendor refund: " + refund.slice(0, 300));

  // A purchase order, approved on submit (the owner meets the default
  // tier), then half of it billed.
  await page.goto(BASE + "/ap/purchase-orders/new", { waitUntil: "networkidle" });
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: vendorName });
  await page.getByLabel("Line 1 account").selectOption({ label: "6200 · Dues & Subscriptions" });
  await page.getByLabel("Line 1 quantity").fill("4");
  await page.getByLabel("Line 1 unit cost").fill("25");
  await page.getByRole("button", { name: "Save and submit" }).click();
  await page.waitForURL(/\/ap\/purchase-orders\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByRole("button", { name: "Create bill" }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/purchase-order.png`, fullPage: true });
  const poPdf = await page.getByRole("link", { name: "PDF" }).getAttribute("href");
  const poPdfRes = await page.request.get(BASE + poPdf);
  const poPdfOk = poPdfRes.status() === 200 && (await poPdfRes.body()).subarray(0, 5).toString() === "%PDF-";
  await page.getByRole("button", { name: "Create bill" }).click();
  await page.getByRole("radio", { name: "Quantity received per line" }).waitFor({ timeout: 10000 });
  await page.getByRole("radio", { name: "A percent of each line" }).click();
  await page.getByRole("dialog").getByLabel("Percent").fill("50");
  await page.getByRole("dialog").getByRole("button", { name: "Create bill" }).click();
  await page.waitForURL(/\/ap\/bills\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const fromPo = await page.locator("main").innerText();
  const poOk = poPdfOk && /Bills\s+PO-/.test(fromPo) && fromPo.includes("$50.00");
  console.log(poOk ? "✓ flow: purchase order approved on submit, PDF, and half of it billed ($50.00)" : "✗ flow: purchase order");
  if (!poOk) problems.push("purchase order: " + fromPo.slice(0, 300));

  // A recurring bill used by hand, then the 1099 report: map an account
  // and download the CSV.
  await page.goto(BASE + "/ap/recurring/new", { waitUntil: "networkidle" });
  await page.getByLabel("Template name").fill(`Smoke rent ${stamp}`);
  await page.getByLabel("Type").selectOption("unscheduled");
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: vendorName });
  await page.getByLabel("Line 1 account").selectOption({ label: "6600 · Rent & Lease" });
  await page.getByLabel("Line 1 amount").fill("1200");
  await page.getByRole("button", { name: "Save template" }).click();
  await page.waitForURL(/\/ap\/recurring\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByRole("button", { name: "Create bill now" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create bill" }).click();
  await page.waitForURL(/\/ap\/bills\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const fromTemplate = await page.locator("main").innerText();
  const rbOk = fromTemplate.includes("$1,200.00");
  console.log(rbOk ? "✓ flow: recurring bill template saved and used for a bill ($1,200.00)" : "✗ flow: recurring bill");
  if (!rbOk) problems.push("recurring bill: " + fromTemplate.slice(0, 300));

  await page.goto(BASE + "/reports/1099", { waitUntil: "networkidle" });
  await page.getByLabel("1099 box for 6200").selectOption("misc_3");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: "networkidle" });
  const mapped = (await page.getByLabel("1099 box for 6200").inputValue()) === "misc_3";
  await page.getByLabel("1099 box for 6200").selectOption("");
  await page.waitForTimeout(800);
  const csvHref = await page.getByRole("link", { name: "Export CSV" }).getAttribute("href");
  const csvRes = await page.request.get(BASE + csvHref);
  const csvOk = csvRes.status() === 200 && csvRes.headers()["content-type"].startsWith("text/csv") && (await csvRes.text()).startsWith("vendor,tin,");
  await page.screenshot({ path: `${outDir}/report-1099-mapped.png`, fullPage: true });
  console.log(mapped && csvOk ? "✓ flow: 1099 box mapped and the CSV exported" : `✗ flow: 1099 (mapped ${mapped}, csv ${csvOk})`);
  if (!(mapped && csvOk)) problems.push("1099 flow");

  // Reports download as CSV and PDF.
  await page.goto(BASE + "/reports/profit-and-loss-by-period", { waitUntil: "networkidle" });
  const csvLink = await page.getByRole("link", { name: "CSV", exact: true }).getAttribute("href");
  const pdfLink = await page.getByRole("link", { name: "PDF", exact: true }).getAttribute("href");
  const pnlCsv = await page.request.get(BASE + csvLink);
  const pnlPdf = await page.request.get(BASE + pdfLink);
  const exportsOk =
    pnlCsv.status() === 200 && (await pnlCsv.text()).startsWith("Account,") &&
    pnlPdf.status() === 200 && (await pnlPdf.body()).subarray(0, 5).toString() === "%PDF-";
  console.log(exportsOk ? "✓ flow: P&L by month downloads as CSV and PDF" : "✗ flow: report exports");
  if (!exportsOk) problems.push(`report exports ${pnlCsv.status()} ${pnlPdf.status()}`);

  // Open invoices link to their documents; the audit trail prints.
  await page.goto(BASE + "/reports/open-invoices", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /^Invoice / }).first().click();
  await page.waitForURL(/\/ar\/invoices\/[0-9a-f-]{36}$/, { timeout: 15000 });
  // The email dialog opens with the customer's address and the invoice template.
  await page.getByRole("button", { name: "Email", exact: true }).click();
  await page.getByText(/^The PDF is attached/).waitFor({ timeout: 10000 });
  await page.locator("[role=dialog] input").nth(2).waitFor();
  const emailSubject = await page.locator("[role=dialog] input").nth(2).inputValue();
  await page.screenshot({ path: `${outDir}/email-dialog.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancel" }).click();
  console.log(emailSubject.startsWith("Invoice ") ? "✓ flow: the email dialog fills in the invoice template" : `✗ flow: email dialog subject "${emailSubject}"`);
  if (!emailSubject.startsWith("Invoice ")) problems.push("email dialog");
  await page.goto(BASE + "/reports/audit-trail", { waitUntil: "networkidle" });
  const trailPdf = await page.request.get(BASE + (await page.getByRole("link", { name: "PDF", exact: true }).getAttribute("href")));
  const trailOk = trailPdf.status() === 200 && (await trailPdf.body()).subarray(0, 5).toString() === "%PDF-";
  console.log(trailOk ? "✓ flow: open invoices link to invoices; the audit trail prints" : "✗ flow: open invoices / audit trail");
  if (!trailOk) problems.push(`audit trail PDF ${trailPdf.status()}`);

  // Close January from its checklist (with a note for the open items), then reopen it.
  await page.goto(BASE + "/periods", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /^Checklist/ }).first().click();
  await page.waitForURL(/\/periods\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText(/^Checks as of/).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/period-checklist.png`, fullPage: true });
  const closeBtn = page.getByRole("button", { name: "Close", exact: true });
  if (await closeBtn.count()) {
    const note = page.getByPlaceholder("Why it's closing anyway");
    if (await note.count()) await note.fill("Smoke test close");
    await closeBtn.click();
    await page.getByText(/^Closed FY/).waitFor({ timeout: 15000 });
  }
  await page.getByPlaceholder("Why it's reopening").fill("Smoke test reopen");
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByText(/^Reopened FY/).waitFor({ timeout: 15000 });
  console.log("✓ flow: a period closes from its checklist and reopens");

  await page.goto(BASE + "/banking/transactions/new?type=check", { waitUntil: "networkidle" });
  await page.getByRole("combobox", { name: "Bank account" }).first().click();
  await page.getByRole("option", { name: "1010 · Checking" }).click();
  await page.getByRole("combobox", { name: "Category" }).first().click();
  await page.getByRole("option", { name: "6200 · Dues & Subscriptions" }).click();
  await page.locator('main tbody input[placeholder="0.00"]').first().fill("1234.56");
  await page.getByPlaceholder("Or type a name").fill(`Smoke Payee ${stamp}`);
  await page.getByText("Print later (adds it to Print checks)").click();
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/banking\/transactions\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Waiting to print").waitFor({ timeout: 10000 });

  await page.goto(BASE + "/banking/checks", { waitUntil: "networkidle" });
  await page.getByText(`Smoke Payee ${stamp}`).waitFor({ timeout: 10000 });
  await page.getByRole("checkbox", { name: "Select all" }).click();
  await page.getByRole("checkbox", { name: "Select all" }).click();
  await page.getByRole("button", { name: /^Print \d+ checks?$/ }).click();
  await page.getByRole("link", { name: "Open checks PDF" }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${outDir}/print-checks.png`, fullPage: true });
  const checksHref = await page.getByRole("link", { name: "Open checks PDF" }).getAttribute("href");
  const res = await page.request.get(BASE + checksHref);
  const checksOk = res.status() === 200 && (await res.body()).subarray(0, 5).toString() === "%PDF-";
  console.log(checksOk ? "✓ flow: queued check numbered and printed to PDF" : "✗ flow: print checks");
  if (!checksOk) problems.push("print checks PDF " + checksHref + " " + res.status());
}

// Flow I: an inventory item with opening stock, its stock page, an
// adjustment, the valuation report, and the invoice form's stock warning.
{
  const name = `Smoke Widget ${Date.now()}`;
  await page.goto(BASE + "/items", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New item" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByPlaceholder("Consulting").fill(name);
  await dlg.locator("select").first().selectOption("inventory");
  await dlg.getByPlaceholder("0.00").first().fill("25");
  await dlg.getByPlaceholder("0.00").nth(1).fill("10");
  await dlg.getByPlaceholder("0", { exact: true }).fill("5");
  await page.screenshot({ path: `${outDir}/item-inventory-new.png`, fullPage: true });
  await dlg.getByRole("button", { name: "Create item" }).click();
  await dlg.waitFor({ state: "hidden", timeout: 15000 });
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("link", { name: "5" }).click();
  await page.waitForURL(/\/items\/[0-9a-f-]{36}$/, { timeout: 15000 });
  const itemUrl = page.url();
  await page.getByText("$50.00").first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/item-stock.png`, fullPage: true });
  await page.getByRole("link", { name: "Adjust quantity" }).click();
  await page.waitForURL(/\/items\/adjustments\/new/, { timeout: 15000 });
  await page.getByPlaceholder("+/−").first().fill("-1");
  await page.getByPlaceholder("Year-end count").fill("Smoke damage");
  await page.screenshot({ path: `${outDir}/inventory-adjustment-new.png`, fullPage: true });
  await page.getByRole("button", { name: "Post adjustment" }).click();
  await page.waitForURL(/\/items\/adjustments\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("-$10.00").first().waitFor({ timeout: 10000 });
  await page.goto(BASE + "/reports/inventory-valuation", { waitUntil: "networkidle" });
  const val = await page.locator("main").innerText();
  await page.screenshot({ path: `${outDir}/inventory-valuation.png`, fullPage: true });
  await page.goto(BASE + "/ar/invoices/new", { waitUntil: "networkidle" });
  await page.locator("tbody select").first().selectOption({ label: name });
  await page.locator('tbody input[inputmode="decimal"]').first().fill("10");
  const warned = await page.getByText("Only 4 on hand").isVisible();
  // Send one back to a vendor: a vendor credit with the product.
  await page.goto(BASE + "/ap/vendor-credits/new", { waitUntil: "networkidle" });
  await page.getByLabel("Vendor", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Line 1 product").selectOption({ label: name });
  await page.getByLabel("Line 1 quantity").fill("1");
  await page.screenshot({ path: `${outDir}/vendor-credit-stock.png`, fullPage: true });
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/ap\/vendor-credits\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.goto(itemUrl, { waitUntil: "networkidle" });
  const stockText = await page.locator("main").innerText();
  const sentBack = stockText.includes("Sent back") && stockText.includes("$30.00");
  const ok = val.includes(name) && val.includes("$40.00") && warned && sentBack;
  console.log(ok ? "✓ flow: inventory item, stock page, adjustment, valuation, stock warning, and a vendor credit sending stock back" : "✗ flow: inventory");
  if (!ok) problems.push(`inventory flow: valuation has item ${val.includes(name)}, $40 ${val.includes("$40.00")}, warned ${warned}, sent back ${sentBack}`);
}

// Flow 2: create an agent and mint a key.
await page.goto(BASE + "/settings/agents", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "New agent" }).click();
await page.getByPlaceholder("Billing assistant").fill(`UI test agent ${Date.now()}`);
await page.getByRole("button", { name: /Post Posts to the ledger/ }).click();
await page.getByPlaceholder(/e\.g\. 500\.00/).fill("250");
await page.getByRole("button", { name: "Create agent" }).click();
await page.waitForURL(/\/settings\/agents\/[0-9a-f-]{36}$/, { timeout: 15000 });
await page.getByPlaceholder(/Key name/).fill("ui");
await page.getByRole("button", { name: "Create key" }).click();
await page.getByText("Copy this key now").waitFor({ timeout: 10000 });
const snippet = await page.locator("pre").innerText();
console.log(snippet.includes("claude mcp add --transport http groundworks") ? "✓ flow: agent + key, Claude Code snippet shown" : "✗ flow: key reveal");
await page.screenshot({ path: `${outDir}/agent-key.png`, fullPage: true });

// Flow 3: approve the demo agent's draft from the review queue (if any left).
await page.goto(BASE + "/review", { waitUntil: "networkidle" });
const postButtons = page.getByRole("button", { name: /^(Post|Approve & post)$/ });
const before = await postButtons.count();
if (before > 0) {
  await postButtons.first().click();
  await page.waitForTimeout(2500);
  await page.reload({ waitUntil: "networkidle" });
  const after = await page.getByRole("button", { name: /^(Post|Approve & post)$/ }).count();
  console.log(after === before - 1 ? `✓ flow: review queue approve (${before} → ${after})` : `✗ flow: review approve ${before} → ${after}`);
} else {
  console.log("· review queue empty, skipped approve flow");
}

// Flow B: banking. Record an expense, import a statement, match the
// expense, add a line by hand, write a rule, reconcile, then undo it so
// the next run can reconcile again.
{
  const stamp = Date.now();
  const amt = (((stamp % 9000) + 1000) / 100).toFixed(2);
  const pick = async (label, option) => {
    await page.getByRole("combobox", { name: label }).first().click();
    await page.getByRole("option", { name: option }).click();
  };
  await page.goto(BASE + "/banking/transactions/new?type=expense", { waitUntil: "networkidle" });
  await pick("Bank account", "1010 · Checking");
  await pick("Category", "6200 · Dues & Subscriptions");
  await page.locator('main tbody input[placeholder="0.00"]').first().fill(amt);
  await page.getByPlaceholder("Or type a name").fill(`Smoke Software ${stamp}`);
  await page.getByRole("button", { name: "Save and post" }).click();
  await page.waitForURL(/\/banking\/transactions\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.getByText("Posted to the ledger").waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/bank-expense.png`, fullPage: true });
  console.log(`✓ flow: expense of ${amt} recorded and posted`);

  const today = new Date().toISOString().slice(0, 10);
  const [y, m, d] = today.split("-");
  const csv = `Date,Description,Amount\n${m}/${d}/${y},SMOKE SOFTWARE ${stamp},-${amt}\n${m}/${d}/${y},SMOKE COFFEE ${stamp},-4.75\n${m}/${d}/${y},SMOKE MONTHLY FEE ${stamp},-12.00\n`;
  await page.goto(BASE + "/banking/review", { waitUntil: "networkidle" });
  const checking = await page.getByRole("combobox", { name: "Account" }).innerText();
  if (!checking.includes("Checking")) await pick("Account", "1010 · Checking");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Import statement" }).click();
  await page.locator("#statement-file").setInputFiles({ name: "smoke.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByText(/3\s+new lines/).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${outDir}/bank-for-review.png`, fullPage: true });
  console.log("✓ flow: statement imported into For review (3 new lines)");

  const softwareRow = page.locator("tr", { hasText: `SMOKE SOFTWARE ${stamp}` });
  await softwareRow.getByRole("button", { name: "Match" }).click();
  await softwareRow.waitFor({ state: "detached", timeout: 15000 });
  console.log("✓ flow: statement line matched to the expense");

  const coffeeRow = page.locator("tr", { hasText: `SMOKE COFFEE ${stamp}` });
  await coffeeRow.getByRole("button", { name: "Categorize" }).click();
  await pick("Category", "6050 · Auto & Travel");
  await page.getByRole("button", { name: /^Add \$4\.75$/ }).click();
  await coffeeRow.waitFor({ state: "detached", timeout: 15000 });
  console.log("✓ flow: statement line categorized and added");

  await page.goto(BASE + "/banking/rules", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New rule" }).click();
  await page.getByPlaceholder("Bank fees").fill(`Smoke fees ${stamp}`);
  await page.getByPlaceholder("service fee").fill(`MONTHLY FEE ${stamp}`);
  await pick("Category", "6100 · Bank & Merchant Fees");
  await page.getByRole("button", { name: "Save rule" }).click();
  await page.getByText(`Smoke fees ${stamp}`).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Run on For review" }).click();
  await page.getByText(/suggested [1-9]/).waitFor({ timeout: 10000 });
  await page.goto(BASE + "/banking/review", { waitUntil: "networkidle" });
  const feeRow = page.locator("tr", { hasText: `SMOKE MONTHLY FEE ${stamp}` });
  await feeRow.getByText(`Rule: Smoke fees ${stamp}`).waitFor({ timeout: 10000 });
  await feeRow.getByRole("button", { name: "Add" }).click();
  await feeRow.waitFor({ state: "detached", timeout: 15000 });
  console.log("✓ flow: bank rule created, suggested, and used to add a line");

  await page.goto(BASE + "/banking/reconcile", { waitUntil: "networkidle" });
  const resume = page.getByRole("button", { name: "Resume reconciling" });
  if (await resume.count()) {
    await resume.click();
  } else {
    await pick("Account", "1010 · Checking");
    await page.locator('main input[type="date"]').first().fill(today);
    await page.locator('main input[inputmode="decimal"]').first().fill("0");
    await page.getByRole("button", { name: "Start reconciling" }).click();
  }
  await page.waitForURL(/\/banking\/reconcile\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const tickAll = page.getByRole("checkbox", { name: "Tick all shown" });
  if ((await tickAll.getAttribute("aria-checked")) !== "true") await tickAll.click();
  await page.waitForTimeout(1500);
  const cleared = await page.locator("div", { hasText: /^Cleared balance$/ }).locator("xpath=following-sibling::div").first().innerText();
  const clearedNum = cleared.replace(/[^0-9.-]/g, "");
  await page.locator('main input[inputmode="decimal"]').first().fill(clearedNum);
  await page.getByRole("button", { name: "Update" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Finish now" }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${outDir}/reconcile-worksheet.png`, fullPage: true });
  await page.getByRole("button", { name: "Finish now" }).click();
  await page.getByText("Items reconciled").waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${outDir}/reconcile-done.png`, fullPage: true });
  console.log(`✓ flow: checking reconciled to ${cleared}`);

  await page.getByRole("button", { name: "Undo reconciliation" }).click();
  await page.getByPlaceholder("Ticked the wrong check").fill("smoke test cleanup");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByText("Undone: smoke test cleanup").waitFor({ timeout: 15000 });
  console.log("✓ flow: reconciliation undone");

  await visit("/banking/register", "bank-register");
  await visit("/banking", "banking-after");
}

// Security headers on a page: per-request CSP nonce + clickjacking guard.
{
  const res = await page.goto(BASE + "/workspace", { waitUntil: "networkidle" });
  const h = res.headers();
  const ok = /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(h["content-security-policy"] ?? "") && h["x-frame-options"] === "DENY" && h["x-content-type-options"] === "nosniff";
  console.log(ok ? "✓ headers: CSP nonce, X-Frame-Options, nosniff" : `✗ headers: ${JSON.stringify(h)}`);
  if (!ok) problems.push("security headers missing");
}

// Flow 4: invite someone (no email configured, so the link is shown).
await page.goto(BASE + "/workspace/people", { waitUntil: "networkidle" });
const inviteEmail = `ui-invite-${Date.now()}@example.com`;
await page.getByPlaceholder("name@company.com").fill(inviteEmail);
await page.getByRole("button", { name: /Create invite link|Send invite/ }).click();
await page.getByLabel("Invitation link").waitFor({ timeout: 10000 });
const inviteLink = await page.getByLabel("Invitation link").inputValue();
console.log(/\/invite\/[\w-]{20,}$/.test(inviteLink) ? "✓ flow: invite link created" : `✗ flow: invite link ${inviteLink}`);
if (!/\/invite\/[\w-]{20,}$/.test(inviteLink)) problems.push("invite flow");
await page.reload({ waitUntil: "networkidle" });
if (!(await page.locator("main").innerText()).includes(inviteEmail)) problems.push("invite not listed as pending");
await page.screenshot({ path: `${outDir}/people-invited.png`, fullPage: true });

// Flow 5: security policy save.
await page.goto(BASE + "/workspace/security", { waitUntil: "networkidle" });
await page.locator("#idle").fill("45");
await page.getByRole("button", { name: "Save policy" }).click();
await page.getByText(/^Saved\./).waitFor({ timeout: 10000 });
console.log("✓ flow: security policy saved");

// Flow 6: complete an access review.
await page.goto(BASE + "/workspace/access-review", { waitUntil: "networkidle" });
const reviewNote = `UI smoke review ${Date.now()}`;
await page.getByPlaceholder(/Notes/).fill(reviewNote);
await page.getByRole("button", { name: "I've reviewed this access" }).click();
await page.locator("li", { hasText: reviewNote }).waitFor({ timeout: 10000 });
console.log("✓ flow: access review recorded");

// Flow 7: audit log export is CSV and includes the policy change.
{
  const res = await context.request.get(BASE + "/workspace/audit/export?event=workspace.");
  const body = await res.text();
  const ok = res.ok() && (res.headers()["content-type"] ?? "").startsWith("text/csv") && body.includes("workspace.security_policy.updated");
  console.log(ok ? "✓ flow: audit CSV export" : `✗ flow: audit export ${res.status()} ${body.slice(0, 120)}`);
  if (!ok) problems.push("audit export");
}

// Flow 8: add a company, land on its dashboard, see it in the switcher.
const companyName = `UI Second Co ${Date.now()}`;
await page.goto(BASE + "/workspace/companies/new", { waitUntil: "networkidle" });
await page.locator("#company-name").fill(companyName);
await page.getByRole("button", { name: "Add company" }).click();
await page.waitForURL(/\/dashboard$/, { timeout: 20000 });
await page.waitForLoadState("networkidle");
const switcherText = await page.locator("header select").first().innerText();
const crumbOk = (await page.locator("header").innerText()).includes(companyName) || switcherText.includes(companyName);
console.log(crumbOk ? "✓ flow: company added and active" : "✗ flow: add company");
if (!crumbOk) problems.push("add company flow");

// Flow 9: start a second workspace through the onboarding wizard, invite
// a teammate on step 2, and land in the new company.
const wsCompany = `UI Other Workspace Co ${Date.now()}`;
await page.goto(BASE + "/onboarding?new=1", { waitUntil: "networkidle" });
await page.locator("#company-name").fill(wsCompany);
await page.getByRole("button", { name: "Create company" }).click();
await page.waitForURL(/\/onboarding\/team$/, { timeout: 20000 });
await page.getByLabel("Email").first().fill(`ui-team-${Date.now()}@example.com`);
await page.getByRole("button", { name: "Send invites" }).click();
await page.getByText(/Send them this link|Invitation emailed/).waitFor({ timeout: 10000 });
await page.getByRole("link", { name: "Go to my books" }).click();
await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
const groups = await page.locator("header select optgroup").count();
console.log(groups >= 2 ? `✓ flow: onboarding wizard (new workspace, invite step); switcher shows ${groups} workspaces` : "✗ flow: onboarding wizard");
if (groups < 2) problems.push("onboarding flow");

// Flow 10: two-step verification. Requiring it sends this (one-factor)
// session to the MFA step; enrolling lands back in the app. Then undo it
// so the next run starts clean. Code 123456 verifies on the fake server.
await page.goto(BASE + "/workspace/security", { waitUntil: "networkidle" });
await page.getByText("Require two-step verification").click();
await page.getByRole("button", { name: "Save policy" }).click();
await page.waitForURL(/\/auth\/mfa/, { timeout: 15000 });
await page.getByAltText("Authenticator QR code").waitFor({ timeout: 10000 });
await page.screenshot({ path: `${outDir}/mfa-enroll.png`, fullPage: true });
await page.getByLabel("6-digit code").fill("123456");
await page.getByRole("button", { name: "Turn on two-step verification" }).click();
await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
console.log("✓ flow: MFA required → enrolled → back in the app");
await page.goto(BASE + "/workspace/security", { waitUntil: "networkidle" });
await page.getByText("Require two-step verification").click();
await page.getByRole("button", { name: "Save policy" }).click();
await page.getByText(/^Saved\./).waitFor({ timeout: 10000 });
await page.goto(BASE + "/account/security", { waitUntil: "networkidle" });
await page.getByText(/^On\./).waitFor({ timeout: 10000 });
await page.getByRole("button", { name: "Turn off" }).click();
await page.getByText(/^Off\./).waitFor({ timeout: 10000 });
console.log("✓ flow: MFA turned off again");

// Phone width sanity.
await page.setViewportSize({ width: 390, height: 844 });
await visit("/dashboard", "dashboard-phone");
await visit("/ar/invoices", "invoices-phone");

// Flow 10b: Groundworks support access: the owner turns it on, then off.
// /support is staff-only, so it's a 404 for this person.
await page.goto(BASE + "/workspace/security", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Allow for 1 day" }).click();
await page.getByText(/^On$/).first().waitFor({ timeout: 10000 });
await page.screenshot({ path: `${outDir}/support-access-on.png`, fullPage: true });
await page.getByRole("button", { name: "Turn off now" }).click();
await page.getByText(/^Off\.$/).first().waitFor({ timeout: 10000 });
expect404 = true;
const supportPage = await page.goto(BASE + "/support", { waitUntil: "networkidle" });
expect404 = false;
console.log(supportPage?.status() === 404 ? "✓ flow: support access on and off; /support is staff-only" : `✗ flow: /support answered ${supportPage?.status()}`);
if (supportPage?.status() !== 404) problems.push("support page not staff-only");

// Flow 10c: All companies lists every workspace and opens a company.
await page.goto(BASE + "/clients", { waitUntil: "networkidle" });
const openButtons = page.getByRole("button", { name: "Open", exact: true });
const canOpen = await openButtons.count();
if (canOpen > 0) {
  await openButtons.first().click();
  await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
}
console.log(canOpen > 0 ? `✓ flow: All companies opens a company (${canOpen} to choose from)` : "✗ flow: All companies has nothing to open");
if (canOpen === 0) problems.push("clients page");

// Flow 11: set a password on My security (it signs out other sessions).
const password = `smoke-pass-${Date.now()}`;
await page.goto(BASE + "/account/security", { waitUntil: "networkidle" });
await page.getByLabel("New password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Save password" }).click();
await page.getByText("Password saved.").waitFor({ timeout: 10000 });
console.log("✓ flow: password set on My security");

// Flow 12: sign out records the session end and drops the cookies.
await page.setViewportSize({ width: 1360, height: 900 });
await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Sign out" }).first().click();
await page.waitForURL(/\/auth\/login/, { timeout: 10000 });
const after = await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
console.log(page.url().includes("/auth/login") ? "✓ flow: signed out" : `✗ flow: sign out (${after?.status()} ${page.url()})`);
if (!page.url().includes("/auth/login")) problems.push("sign out flow");
await visit("/signup", "signup", true);
await visit("/auth/login", "login", true);

// Flow 13: email + password sign-in. A wrong password is refused.
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password", { exact: true }).fill("not-the-password");
expectRejectedSignIn = true;
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.getByText("That email and password don't match.").waitFor({ timeout: 10000 });
expectRejectedSignIn = false;
await page.getByLabel("Password", { exact: true }).fill(password);
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
console.log("✓ flow: wrong password refused; right one signs in");
await page.getByRole("button", { name: "Sign out" }).first().click();
await page.waitForURL(/\/auth\/login/, { timeout: 10000 });

// Flow 14: forgotten password sends a reset link.
await visit("/auth/forgot", "forgot", true);
await page.getByLabel("Email").fill(email);
await page.getByRole("button", { name: "Email me a reset link" }).click();
await page.getByText("Check your email.").waitFor({ timeout: 10000 });
console.log("✓ flow: reset link requested");

// Flow 15: sign up with a password: in at once, company carried to onboarding.
const fresh = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const signup = await fresh.newPage();
signup.on("pageerror", (e) => problems.push(`pageerror on ${signup.url()}: ${e.message}`));
signup.on("console", consoleProblem(signup));
await signup.goto(BASE + "/signup", { waitUntil: "networkidle" });
await signup.getByLabel("Your name").fill("Sam Smoke");
await signup.getByLabel("Email").fill(`ui-signup-${Date.now()}@example.com`);
await signup.getByLabel("Password", { exact: true }).fill("short");
await signup.getByLabel("Company name").fill("Smoke Test Co");
const tooShort = await signup.getByLabel("Password", { exact: true }).evaluate((el) => !el.checkValidity());
console.log(tooShort ? "✓ flow: a short password is refused" : "✗ flow: short password accepted");
if (!tooShort) problems.push("password length rule");
await signup.getByLabel("Password", { exact: true }).fill(`signup-pass-${Date.now()}`);
await signup.screenshot({ path: `${outDir}/signup-filled.png`, fullPage: true });
await signup.getByRole("button", { name: "Create account" }).click();
await signup.waitForURL(/\/onboarding/, { timeout: 15000 });
await signup.getByText("SET UP YOUR COMPANY").waitFor({ timeout: 10000 });
const prefilled = (await signup.locator("#company-name").inputValue()) === "Smoke Test Co";
await signup.screenshot({ path: `${outDir}/signup-onboarding.png`, fullPage: true });
console.log(prefilled ? "✓ flow: sign-up with password lands on onboarding, company filled in" : "✗ flow: sign-up company not carried");
if (!prefilled) problems.push("sign-up flow");
await fresh.close();

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join("\n")}` : "\nNo problems.");
process.exit(problems.length ? 1 : 0);
