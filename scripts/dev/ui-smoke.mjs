/**
 * UI smoke test: signs in through a fake Supabase session cookie, loads
 * every main page (fails on any 4xx/5xx, error boundary, or console
 * error), and clicks through three flows — create + post an invoice,
 * create an agent + key, approve from the review queue.
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
const session = {
  access_token: "fake-access-token",
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
page.on("console", (m) => { if (m.type() === "error") problems.push(`console on ${page.url()}: ${m.text()}`); });

async function visit(path, name) {
  const res = await page.goto(BASE + path, { waitUntil: "networkidle" });
  const status = res?.status();
  const body = await page.locator("body").innerText();
  const bad = status >= 400 || /Application error|Internal Server Error|Unhandled Runtime Error/.test(body) || page.url().includes("/auth/login");
  console.log(`${bad ? "✗" : "✓"} ${status} ${path}${page.url() !== BASE + path ? `  -> ${page.url().replace(BASE, "")}` : ""}`);
  if (bad) problems.push(`bad page ${path} (${status}) ${body.slice(0, 200)}`);
  if (name) await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

const pages = [
  ["/dashboard", "dashboard"], ["/customers", "customers"], ["/items", "items"],
  ["/ar/invoices", "invoices"], ["/ar/invoices/new", "invoice-new"], ["/ar/payments", null],
  ["/ar/payments/new", "receive-payment"], ["/vendors", null], ["/ap/bills", null], ["/ap/bills/new", null],
  ["/ap/payments", null], ["/accounts", null], ["/gl", null], ["/reports/ar-aging", "ar-aging"],
  ["/reports/ap-aging", null], ["/reports/income-statement", null], ["/reports/balance-sheet", null],
  ["/review", "review"], ["/settings/agents", "agents"], ["/settings/api-keys", "api-keys"],
  ["/settings/team", "team"], ["/activity", "activity"], ["/settings/approval-thresholds", null],
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

// Phone width sanity.
await page.setViewportSize({ width: 390, height: 844 });
await visit("/dashboard", "dashboard-phone");
await visit("/ar/invoices", "invoices-phone");

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join("\n")}` : "\nNo problems.");
process.exit(problems.length ? 1 : 0);
