/**
 * UI smoke test: signs in through a fake Supabase session cookie, loads
 * every main page (fails on any 4xx/5xx, error boundary, or console
 * error, CSP violations included), and clicks through the main flows:
 * create + post an invoice, create an agent + key, approve from the
 * review queue, invite someone, add a company and switch to it, save the
 * security policy, complete an access review, export the audit log, set a
 * password, sign out, sign back in with it, ask for a reset link, and sign
 * up a new account with a password.
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
// The wrong-password check expects one rejected sign-in request.
let expectRejectedSignIn = false;
const consoleProblem = (pg) => (m) => {
  if (m.type() !== "error") return;
  if (expectRejectedSignIn && m.location().url.includes("/auth/v1/token")) return;
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
  if (name) await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

const pages = [
  ["/dashboard", "dashboard"], ["/customers", "customers"], ["/items", "items"],
  ["/ar/invoices", "invoices"], ["/ar/invoices/new", "invoice-new"], ["/ar/payments", null],
  ["/ar/payments/new", "receive-payment"], ["/vendors", null], ["/ap/bills", null], ["/ap/bills/new", null],
  ["/ap/payments", null], ["/accounts", null], ["/gl", null], ["/reports/ar-aging", "ar-aging"],
  ["/reports/ap-aging", null], ["/reports/income-statement", null], ["/reports/balance-sheet", null],
  ["/review", "review"], ["/settings/agents", "agents"], ["/settings/api-keys", "api-keys"],
  ["/activity", "activity"], ["/settings/approval-thresholds", null],
  ["/workspace", "workspace"], ["/workspace/people", "people"], ["/workspace/security", "security-policy"],
  ["/workspace/access-review", "access-review"], ["/workspace/audit", "audit-log"], ["/workspace/companies/new", null],
  ["/account/security", "my-security"],
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
