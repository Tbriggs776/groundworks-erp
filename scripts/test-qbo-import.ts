/**
 * End-to-end: the QuickBooks Online importer, against a fake QuickBooks
 * (scripts/lib/fake-qbo.ts). Sealing and signing, the sign-in state,
 * connecting (a new company), the import in resumable batches through a
 * failed batch, throttling, an expired token, and a record that slipped
 * between pages; then what came across: company, chart of accounts, terms,
 * classes, departments, customers, vendors, items, and journal entries
 * with QuickBooks' amounts. Also who may run it, reconnecting, and
 * disconnecting.
 *
 *   npx tsx scripts/test-qbo-import.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { accounts, auditLog, organizations, qboConnections, qboIdMap, qboImports } from "../src/lib/db/schema";
import { runAs, runAsWorkspace, userActor, workspaceActor, type Actor, type Role } from "../src/lib/actor";
import { customerBalanceSql } from "../src/lib/ar/balances";
import * as reconcile from "../src/lib/banking/reconcile";
import { toAppError } from "../src/lib/errors";
import { getCompanyProfile } from "../src/lib/company/profile";
import { checkState, startAuthorization, STATE_COOKIE } from "../src/lib/qbo/oauth";
import * as qbo from "../src/lib/qbo/service";
import * as tieout from "../src/lib/qbo/tieout";
import { seal, sign, unseal, verifySigned } from "../src/lib/security/crypto";
import * as ws from "../src/lib/workspace/service";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, GOOD_CODE, startFakeQbo } from "./lib/fake-qbo";
import { assert, assertEq, check, deleteOrgs, expectError, finish, section } from "./lib/harness";

const stamp = Date.now();
const PREFIX = `qbo-${stamp}`;
const REALM = "9130354";

async function newUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `${tag}-${stamp}@example.com`;
  const [row] = await db.execute<{ id: string }>(sql`INSERT INTO auth.users (email) VALUES (${email}) RETURNING id`);
  return { id: row.id, email };
}

async function main() {
  const fake = await startFakeQbo({ realmId: REALM, companyName: `${PREFIX} Craig's Design and Landscaping` });
  Object.assign(process.env, {
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    QBO_CLIENT_ID: FAKE_CLIENT_ID,
    QBO_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    QBO_ENVIRONMENT: "sandbox",
    NEXT_PUBLIC_APP_URL: "http://localhost:3100",
    QBO_AUTH_URL: `${fake.url}/connect/oauth2`,
    QBO_TOKEN_URL: `${fake.url}/oauth2/v1/tokens/bearer`,
    QBO_REVOKE_URL: `${fake.url}/revoke`,
    QBO_API_BASE: fake.url,
  });

  const owner = await newUser("qbo-owner");
  const member = await newUser("qbo-member");
  const { workspaceId } = await db.transaction((tx) =>
    ws.createWorkspace(tx, owner, { name: `${PREFIX} First Co`, workspaceName: `${PREFIX} Holdings`, fullName: "Quinn Owner" })
  );
  let orgId = "";
  const as = (role: Role = "owner"): Actor => userActor({ organizationId: orgId, userId: owner.id, role });
  const asAgent = (): Actor => ({ ...as("admin"), kind: "agent", userId: null, agentId: null });
  const batch = (budgetMs = 20_000, actor = as()) => runAs(actor, (ctx) => qbo.runImportBatch(ctx, { budgetMs }));
  const view = () => runAs(as("viewer"), (ctx) => qbo.getImportStatus(ctx));

  section("Sealing and signing");
  await check("sealed secrets open with the key, differ each time, and refuse tampering", async () => {
    const a = seal("refresh-token-1");
    const b = seal("refresh-token-1");
    assert(a !== b, "a fresh IV each time");
    assert(!a.includes("refresh-token-1"), "nothing readable in the sealed value");
    assertEq(unseal(a), "refresh-token-1", "opens");
    const [v, iv, tag, body] = a.split(".");
    const flipped = body.slice(0, -2) + (body.endsWith("A") ? "BB" : "AA");
    let refused = false;
    try {
      unseal([v, iv, tag, flipped].join("."));
    } catch {
      refused = true;
    }
    assert(refused, "a tampered value doesn't open");
  });

  await check("signed values verify; altered ones don't", async () => {
    const t = sign({ w: "ws", n: 1 });
    assertEq(verifySigned<{ w: string }>(t)?.w, "ws", "payload");
    const [body] = t.split(".");
    const forged = `${Buffer.from(JSON.stringify({ w: "other", n: 1 })).toString("base64url")}.${t.split(".")[1]}`;
    assertEq(verifySigned(forged), null, "forged body");
    assertEq(verifySigned(`${body}.AAAA`), null, "bad signature");
  });

  section("Sign in with Intuit");
  await check("the sign-in link carries the app, scope, redirect, and a signed state", async () => {
    const { url, nonce } = startAuthorization({ workspaceId, userId: owner.id });
    const u = new URL(url);
    assertEq(u.origin + u.pathname, `${fake.url}/connect/oauth2`, "Intuit's page");
    assertEq(u.searchParams.get("client_id"), FAKE_CLIENT_ID, "client id");
    assertEq(u.searchParams.get("scope"), "com.intuit.quickbooks.accounting", "scope");
    assertEq(u.searchParams.get("redirect_uri"), "http://localhost:3100/api/qbo/callback", "redirect");
    const s = checkState(u.searchParams.get("state"), nonce, owner.id);
    assertEq(s.w, workspaceId, "workspace in the state");
    assertEq(STATE_COOKIE, "gw_qbo_state", "cookie name");
  });

  await check("the callback refuses a state from another browser, person, or too long ago", async () => {
    const { url, nonce } = startAuthorization({ workspaceId, userId: owner.id });
    const state = new URL(url).searchParams.get("state");
    await expectError(async () => checkState(state, "other-nonce", owner.id), "forbidden");
    await expectError(async () => checkState(state, undefined, owner.id), "forbidden");
    await expectError(async () => checkState(state, nonce, member.id), "forbidden");
    const old = sign({ w: workspaceId, u: owner.id, n: nonce, t: Date.now() - 11 * 60 * 1000 });
    await expectError(async () => checkState(old, nonce, owner.id), "forbidden");
    await expectError(async () => checkState("garbage", nonce, owner.id), "forbidden");
  });

  section("Connect: a new company");
  await check("a workspace member can't import; a bad code is refused", async () => {
    await expectError(
      () => runAsWorkspace(workspaceActor({ workspaceId, userId: member.id, role: "member" }), (ctx) => qbo.beginImport(ctx, { code: GOOD_CODE, realmId: REALM })),
      "forbidden"
    );
    await expectError(
      () => runAsWorkspace(workspaceActor({ workspaceId, userId: owner.id, role: "owner" }), (ctx) => qbo.beginImport(ctx, { code: "stale", realmId: REALM })),
      "forbidden"
    );
  });

  await check("connecting makes the company, with sealed tokens and an import ready to run", async () => {
    const r = await runAsWorkspace(workspaceActor({ workspaceId, userId: owner.id, role: "owner" }), (ctx) => qbo.beginImport(ctx, { code: GOOD_CODE, realmId: REALM }));
    orgId = r.organizationId;
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    assertEq(org.name, `${PREFIX} Craig's Design and Landscaping`, "named after the QuickBooks company");
    assertEq(org.workspaceId, workspaceId, "in this workspace");
    const [conn] = await db.select().from(qboConnections).where(eq(qboConnections.organizationId, orgId));
    assertEq(conn.realmId, REALM, "realm");
    assert(conn.refreshToken && !conn.refreshToken.includes(fake.state.refreshToken), "refresh token sealed");
    assertEq(unseal(conn.refreshToken!), fake.state.refreshToken, "and opens to Intuit's");
    const v = await view();
    assertEq(v.status, "running", "import waiting");
    assertEq(v.steps[0].state, "current", "first step next");
    assertEq(v.connection?.connected, true, "connected");
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, orgId), eq(auditLog.event, "qbo.connected")));
    assert(a, "connection audited");
  });

  section("Who runs the import");
  await check("viewers, bookkeepers, and agents can't run it; anyone with read sees progress", async () => {
    await expectError(() => batch(20_000, as("viewer")), "forbidden");
    await expectError(() => batch(20_000, as("bookkeeper")), "forbidden");
    await expectError(() => batch(20_000, asAgent()), "forbidden");
    assertEq((await runAs(asAgent(), (ctx) => qbo.getImportStatus(ctx))).status, "running", "agent reads status");
  });

  section("Running in batches");
  const cursor = async () => (await db.select().from(qboImports).where(eq(qboImports.organizationId, orgId)))[0].cursor;

  await check("tiny batches move forward a record at a time and keep their place", async () => {
    let before = 0;
    for (let i = 0; i < 8; i++) {
      const v = await batch(1);
      const done = v.steps.filter((s) => s.state === "done").length;
      assert(done >= before, "never moves backwards");
      before = done;
    }
    const v = await view();
    assertEq(v.batches, 8, "batches counted");
    const c = await cursor();
    assertEq(c.step, "terms", "on terms after the company and the chart");
    assertEq(c.position, (v.steps.find((s) => s.key === "terms")?.imported ?? 0) + 1, "resumes right after the last term");
  });

  await check("a failed batch saves nothing of its own and says what happened", async () => {
    const termsBefore = (await view()).steps.find((s) => s.key === "terms")!.imported;
    fake.state.failEntity = "Term";
    const message = await batch(20_000).then(
      () => "",
      async (e) => {
        const m = toAppError(e).message;
        await qbo.recordImportFailure(orgId, m);
        return m;
      }
    );
    assert(message.includes("QuickBooks"), `failure names QuickBooks: ${message}`);
    const v = await view();
    assertEq(v.status, "failed", "status");
    assertEq(v.lastError, message, "error kept for the page");
    assertEq(v.steps.find((s) => s.key === "accounts")?.state, "done", "earlier steps stay done");
    const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM qbo_id_map WHERE organization_id = ${orgId} AND entity = 'Term'`);
    assertEq(n, termsBefore, "no terms saved from the failed batch");
  });

  await check("trying again finishes through a throttle, an expired token, and a record that slipped between pages", async () => {
    fake.state.failEntity = null;
    fake.state.throttle = 2;
    fake.state.hideOnce = { entity: "Vendor", id: "2" };
    fake.expireAccess();
    const refreshesBefore = fake.state.refreshes;
    let v = await batch(20_000);
    for (let i = 0; i < 10 && v.status === "running"; i++) v = await batch(20_000);
    assertEq(v.status, "done", `finished (${v.lastError ?? ""})`);
    assertEq(v.lastError, null, "error cleared");
    assertEq(fake.state.refreshes, refreshesBefore + 1, "refreshed once after the 401");
    const [conn] = await db.select().from(qboConnections).where(eq(qboConnections.organizationId, orgId));
    assertEq(unseal(conn.refreshToken!), fake.state.refreshToken, "the rotated refresh token was saved");
    assertEq(v.steps.find((s) => s.key === "vendors")?.imported, 3, "the slipped vendor came across on the rescan");
    const [fin] = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, orgId), eq(auditLog.event, "qbo.import.finished")));
    assert(fin, "finish audited");
  });

  await check("lists page past QuickBooks' 1000 a page", async () => {
    const t = (await view()).steps.find((s) => s.key === "terms")!;
    assertEq(t.imported, 2000, "every term, active or not");
    const starts = fake.state.queries.filter((q) => q.startsWith("select * from Term")).map((q) => Number(q.match(/startposition (\d+)/)?.[1]));
    assert(starts.some((s) => starts.includes(s + 1000)), `went on to the next page (${starts.join(", ")})`);
  });

  await check("running again after it's done changes nothing", async () => {
    const before = await view();
    const [{ n: maps }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM qbo_id_map WHERE organization_id = ${orgId}`);
    const after = await batch(20_000);
    assertEq(after.batches, before.batches, "no new batch");
    const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM qbo_id_map WHERE organization_id = ${orgId}`);
    assertEq(n, maps, "id map unchanged");
  });

  const notes = async () => (await view()).notes;
  const acct = async (code: string) => {
    const [a] = await db.select().from(accounts).where(and(eq(accounts.organizationId, orgId), eq(accounts.code, code)));
    return a;
  };
  const localId = async (entity: string, qboId: string) => {
    const [m] = await db.select().from(qboIdMap).where(and(eq(qboIdMap.organizationId, orgId), eq(qboIdMap.entity, entity), eq(qboIdMap.qboId, qboId)));
    return m?.localId ?? null;
  };

  section("Company");
  await check("fiscal year, currency, and profile come from QuickBooks", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    assertEq(org.fiscalYearStartMonth, 7, "fiscal year starts in July");
    assertEq(org.baseCurrency, "USD", "currency");
    const p = await runAs(as(), (ctx) => getCompanyProfile(ctx));
    assertEq(p.legalName, `${PREFIX} Craig's Design and Landscaping LLC`, "legal name");
    assertEq(p.address?.city, "San Pablo", "address");
  });

  section("Chart of accounts");
  await check("system accounts keep Groundworks' numbers and take QuickBooks' names", async () => {
    const ar = await acct("1200");
    assertEq(ar.name, "Accounts Receivable (A/R)", "AR renamed");
    assertEq(await localId("Account", "2"), ar.id, "mapped");
    assert((await notes()).some((x) => x.includes("Accounts Receivable (A/R) is numbered 1200") && x.includes("1100")), "renumbering noted");
    assertEq((await acct("2000")).name, "Accounts Payable (A/P)", "AP");
    assertEq((await acct("1250")).name, "Undeposited Funds", "undeposited funds");
    assertEq((await acct("1300")).name, "Inventory Asset", "inventory asset");
    assertEq((await acct("2200")).name, "Board of Equalization Payable", "sales tax payable");
    assertEq((await acct("3300")).isActive, true, "opening balance equity");
  });

  await check("QuickBooks numbers win over unused defaults; taken ones get the next free number", async () => {
    const checking = await acct("1010");
    assertEq(await localId("Account", "1"), checking.id, "Checking took 1010");
    assertEq(checking.isCash, true, "bank account is cash");
    const aside = await acct("D1010");
    assert(aside && !aside.isActive, "default Checking moved aside and inactive");
    assertEq((await acct("4000")).name, "Sales of Product Income", "4000");
    const services = await acct("4010");
    assertEq(services?.name, "Services", "Services renumbered off the load-bearing 4930");
    assert((await notes()).some((x) => x.includes("Services is numbered 4010") && x.includes("4930")), "noted");
    assertEq((await acct("4930")).isActive, true, "4930 stays active");
    const install = await acct("4011");
    assertEq(install?.name, "Installation", "sub-account right after its parent");
    assertEq(install.indentation, 1, "indented");
  });

  await check("types, contra accounts, inactive accounts, and leftover defaults", async () => {
    const rent = await acct("6010");
    assertEq(rent?.name, "Rent Expense", "next free round number");
    assertEq(rent.subcategory, "operating_expense", "expense");
    const old = await db.select().from(accounts).where(and(eq(accounts.organizationId, orgId), eq(accounts.name, "Old Expense")));
    assertEq(old[0]?.isActive, false, "inactive in QuickBooks, inactive here");
    const accum = await db.select().from(accounts).where(and(eq(accounts.organizationId, orgId), eq(accounts.name, "Accumulated Depreciation"), eq(accounts.isActive, true)));
    assertEq(accum.length, 1, "one active accumulated depreciation");
    assertEq(accum[0].normalBalance, "credit", "contra asset");
    const visa = await db.select().from(accounts).where(and(eq(accounts.organizationId, orgId), eq(accounts.name, "Visa")));
    assertEq(visa[0].code, "2110", "credit card");
    assertEq((await acct("6900")).isActive, false, "unused default deactivated");
    assertEq((await acct("7400")).isActive, true, "load-bearing default stays");
  });

  section("Lists");
  await check("date-driven terms are noted; classes and departments keep their tree", async () => {
    assert((await notes()).some((x) => x.includes('Term "Due on the 10th"')), "date-driven term noted");
    const rows = await db.execute<{ name: string; parent: string | null; blocked: boolean; dim: string }>(sql`
      SELECT v.name, p.name AS parent, v.is_blocked AS blocked, d.code AS dim
        FROM dimension_values v JOIN dimensions d ON d.id = v.dimension_id
        LEFT JOIN dimension_values p ON p.id = v.parent_value_id
       WHERE v.organization_id = ${orgId} AND d.code IN ('CLASS', 'LOCATION')`);
    const by = new Map(rows.map((r) => [r.name, r]));
    assertEq(by.get("Commercial:Retail")?.parent, "Commercial", "sub-class under its parent");
    assertEq(by.get("Old")?.blocked, true, "inactive class blocked");
    assertEq(by.get("North")?.dim, "LOCATION", "departments are locations");
  });

  await check("customers: email, terms, inactive, and one the app refuses is noted", async () => {
    const rows = await db.execute<{ name: string; email: string | null; days: number; active: boolean; exempt: boolean }>(sql`
      SELECT name, email, default_payment_terms_days AS days, is_active AS active, tax_exempt AS exempt
        FROM customers WHERE organization_id = ${orgId}`);
    const by = new Map(rows.map((r) => [r.name, r]));
    assertEq(rows.length, 4, "four of five came across");
    assertEq(by.get("Amy's Bird Sanctuary")?.email, "Birds@Intuit.com", "email");
    assertEq(by.get("Amy's Bird Sanctuary")?.days, 30, "Net 30");
    assertEq(by.get("Bill's Windsurf Shop")?.email, "Surf@Intuit.com", "first real address");
    assertEq(by.get("Bad Email Co")?.email, null, "no valid address");
    assertEq(by.get("Bad Email Co")?.exempt, true, "not taxable");
    assertEq(by.get("Cool Cars")?.active, false, "inactive");
    assert((await notes()).some((x) => x.startsWith("Customer Euro Customer didn't come across")), "refusal noted");
    const c = (await view()).steps.find((s) => s.key === "customers")!;
    assertEq(c.skipped, 1, "counted as skipped");
  });

  await check("vendors: 1099 flag with a note about tax IDs", async () => {
    const rows = await db.execute<{ name: string; is1099: boolean; days: number }>(sql`
      SELECT name, is_1099_vendor AS is1099, default_payment_terms_days AS days FROM vendors WHERE organization_id = ${orgId}`);
    const bessie = rows.find((r) => r.name === "Books by Bessie");
    assertEq(bessie?.is1099, true, "1099");
    assertEq(bessie?.days, 15, "Net 15");
    assert((await notes()).some((x) => x.includes("Books by Bessie is a 1099 vendor")), "TIN note");
  });

  await check("items: accounts mapped, inventory on its asset account, bundles noted", async () => {
    const rows = await db.execute<{ name: string; type: string; income: string | null; asset: string | null; expense: string | null; sku: string | null }>(sql`
      SELECT name, type, income_account_id AS income, asset_account_id AS asset, expense_account_id AS expense, sku
        FROM items WHERE organization_id = ${orgId}`);
    const by = new Map(rows.map((r) => [r.name, r]));
    assertEq(by.get("Design")?.income, await localId("Account", "9"), "service income");
    const rock = by.get("Rock Fountain");
    assertEq(rock?.type, "inventory", "inventory item");
    assertEq(rock?.asset, (await acct("1300")).id, "inventory asset");
    assertEq(rock?.expense, await localId("Account", "11"), "COGS");
    assertEq(rock?.sku, "RF-1", "sku");
    assert(by.get("Pump")?.income, "fallback income account");
    assert(by.has("Sprinklers:Sprinkler Heads"), "sub-item keeps its full name");
    assert(!by.has("Garden Kit") && !by.has("Landscaping"), "bundles and categories aren't items");
    assert((await notes()).some((x) => x.includes('Bundle "Garden Kit"')), "bundle noted");
  });

  section("Journal entries");
  await check("posted as conversion journals with QuickBooks' amounts, dates, and tags", async () => {
    const rows = await db.execute<{ doc: string | null; date: string; source: string; code: string; status: string }>(sql`
      SELECT j.document_no AS doc, j.journal_date::text AS date, j.source, sc.code, j.status
        FROM gl_journals j JOIN source_codes sc ON sc.id = j.source_code_id
       WHERE j.organization_id = ${orgId} AND j.source = 'conversion' ORDER BY j.journal_date`);
    assertEq(rows.length, 5, "five posted");
    assert(rows.every((r) => r.source === "conversion" && r.status === "posted"), "conversion, posted");
    assertEq(rows.find((r) => r.doc === "ADJ-1")?.code, "ADJ", "adjustment keeps its kind");
    assertEq(rows.find((r) => r.doc === "JE-1")?.code, "GJ", "general journal");
    const [tag] = await db.execute<{ dims: number }>(sql`
      SELECT count(*)::int AS dims FROM gl_line_dimensions ld JOIN gl_lines l ON l.id = ld.line_id
        JOIN gl_journals j ON j.id = l.journal_id WHERE j.organization_id = ${orgId} AND j.journal_date = '2025-07-20'`);
    assertEq(tag.dims, 2, "class and department on the rent line");
    const [ar] = await db.execute<{ customer: string | null }>(sql`
      SELECT l.customer_id AS customer FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
       WHERE j.organization_id = ${orgId} AND j.document_no = 'ADJ-1' AND l.debit > 0`);
    assertEq(ar.customer, await localId("Customer", "1"), "customer on the AR line");
  });

  await check("fiscal years are made as the history needs them, on QuickBooks' calendar", async () => {
    const rows = await db.execute<{ label: string; start: string; end: string }>(sql`
      SELECT year_label AS label, start_date::text AS start, end_date::text AS end FROM fiscal_years WHERE organization_id = ${orgId} ORDER BY start_date`);
    assertEq(rows.map((r) => `${r.label} ${r.start}`).join(", "), "FY2026 2025-07-01, FY2027 2026-07-01", "July years");
  });

  await check("the ones that couldn't post are noted", async () => {
    const n = await notes();
    assert(n.some((x) => x.startsWith("Journal entry JE-5") && x.includes("isn't in the chart")), "unknown account noted");
    assert(n.some((x) => x.startsWith("Journal entry JE-6") && x.includes("didn't post")), "unbalanced noted");
    const je = (await view()).steps.find((s) => s.key === "journal_entries")!;
    assertEq(je.imported, 5, "imported");
    assertEq(je.skipped, 3, "skipped (unknown account, unbalanced, empty)");
  });

  // Σ debit − credit on an account, from every posted journal.
  const balance = async (accountId: string | null) => {
    const [r] = await db.execute<{ b: string }>(sql`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id
       WHERE j.organization_id = ${orgId} AND l.account_id = ${accountId} AND j.status IN ('posted', 'reversed')`);
    return Number(r.b);
  };
  const qboAccount = async (qboId: string) => (await localId("Account", qboId))!;

  section("Sales tax");
  await check("agencies, rates, and combined rates come across as QuickBooks had them", async () => {
    const rates = await db.execute<{ name: string; pct: string; active: boolean; agency: string; liability: string }>(sql`
      SELECT r.name, r.rate_percent::text AS pct, r.is_active AS active, a.name AS agency, acct.code AS liability
        FROM tax_rates r JOIN tax_agencies a ON a.id = r.agency_id JOIN accounts acct ON acct.id = a.liability_account_id
       WHERE r.organization_id = ${orgId}`);
    const by = new Map(rates.map((r) => [r.name, r]));
    assertEq(Number(by.get("California")?.pct), 8, "California 8%");
    assertEq(by.get("California")?.agency, "Board of Equalization", "its agency");
    assertEq(by.get("California")?.liability, "2200", "accrues in its payable account");
    assertEq(by.get("Tucson City")?.agency, "City of Tucson", "second agency");
    assertEq(by.get("Old Rate")?.active, false, "inactive rate");
    const codes = await db.execute<{ name: string; n: number }>(sql`
      SELECT c.name, count(cc.id)::int AS n FROM tax_codes c JOIN tax_code_components cc ON cc.tax_code_id = c.id
       WHERE c.organization_id = ${orgId} GROUP BY c.name`);
    assertEq(codes.find((c) => c.name === "CA + Tucson")?.n, 2, "combined rate has both components");
    assertEq(codes.find((c) => c.name === "California")?.n, 1, "each rate is a single rate too");
  });

  section("Sales history");
  await check("invoices keep QuickBooks' numbers, lines, discounts, tax, and tags", async () => {
    const [inv] = await db.execute<{ id: string; status: string; subtotal: string; tax: string; total: string; code: string | null; memo: string | null }>(sql`
      SELECT i.id, i.status, i.subtotal_amount::text AS subtotal, i.tax_amount::text AS tax, i.total_amount::text AS total, c.name AS code, i.memo
        FROM ar_invoices i LEFT JOIN tax_codes c ON c.id = i.tax_code_id WHERE i.organization_id = ${orgId} AND i.invoice_number = '1001'`);
    assertEq(Number(inv.subtotal), 415, "subtotal after the discount");
    assertEq(Number(inv.tax), 22, "QuickBooks' tax");
    assertEq(Number(inv.total), 437, "total");
    assertEq(inv.code, "California", "tax rate picked");
    assertEq(inv.status, "paid", "paid by its payment and credit memo");
    assertEq(inv.memo, "Thank you for your business.", "customer message");
    const lines = await db.execute<{ amount: string; code: string; dims: number }>(sql`
      SELECT l.amount::text AS amount, a.code, jsonb_array_length(l.dimensions) AS dims FROM ar_invoice_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.invoice_id = ${inv.id} ORDER BY l.line_number`);
    assertEq(lines.map((l) => Number(l.amount)).join(","), "150,275,-10", "line amounts");
    assertEq(lines[2].code, "4950", "discount on Discounts given");
    assertEq(lines[0].dims, 2, "class and location on a line");
    const tax = await db.execute<{ amt: string }>(sql`SELECT tax_amount::text AS amt FROM sales_tax_lines WHERE invoice_id = ${inv.id}`);
    assertEq(tax.map((t) => Number(t.amt)).join(","), "22", "tax line");
  });

  await check("bundles expand, shipping and combined tax come across, voided invoices stay voided", async () => {
    const [two] = await db.execute<{ id: string; total: string }>(sql`
      SELECT id, total_amount::text AS total FROM ar_invoices WHERE organization_id = ${orgId} AND invoice_number = '1002'`);
    assertEq(Number(two.total), 151, "total");
    const lines = await db.execute<{ d: string | null; amount: string }>(sql`
      SELECT description AS d, amount::text AS amount FROM ar_invoice_lines WHERE invoice_id = ${two.id} ORDER BY line_number`);
    assertEq(lines.length, 3, "pump, the bundle's design line, shipping");
    assertEq(lines[2].d, "Shipping", "shipping line");
    const tax = await db.execute<{ amt: string }>(sql`SELECT tax_amount::text AS amt FROM sales_tax_lines WHERE invoice_id = ${two.id} ORDER BY tax_amount DESC`);
    assertEq(tax.map((t) => Number(t.amt)).join(","), "4.8,1.2", "tax per rate");
    const [voided] = await db.execute<{ status: string; total: string; reason: string }>(sql`
      SELECT status, total_amount::text AS total, void_reason AS reason FROM ar_invoices WHERE organization_id = ${orgId} AND invoice_number = '1003'`);
    assertEq(voided.status, "voided", "voided");
    assertEq(Number(voided.total), 0, "zero");
    assert((await notes()).some((x) => x.startsWith("Invoice 1006 didn't come across") && x.includes("Euro Customer")), "missing customer noted");
  });

  await check("credit memos, sales receipts, and refunds", async () => {
    const memos = await db.execute<{ n: string; status: string }>(sql`SELECT memo_number AS n, status FROM credit_memos WHERE organization_id = ${orgId} ORDER BY memo_number`);
    assertEq(memos.map((m) => `${m.n}:${m.status}`).join(", "), "5001:applied, 5001-2:open", "numbers kept, duplicate renumbered");
    assert((await notes()).some((x) => x.includes("Credit memo 5001 is numbered 5001-2")), "duplicate noted");
    const receipts = await db.execute<{ n: string; customer: string | null; method: string; acct: string }>(sql`
      SELECT r.receipt_number AS n, r.customer_id AS customer, r.method, a.code AS acct FROM sales_receipts r JOIN accounts a ON a.id = r.deposit_account_id
       WHERE r.organization_id = ${orgId} ORDER BY r.receipt_number`);
    assertEq(receipts[0].customer, null, "walk-in sale");
    assertEq(receipts[0].method, "cash", "payment method mapped");
    assertEq(receipts[0].acct, "1250", "into Undeposited Funds");
    assertEq(receipts[1].method, "credit_card", "card");
    const [refund] = await db.execute<{ status: string; ref: string; total: string }>(sql`
      SELECT status, reference AS ref, total_amount::text AS total FROM refund_receipts WHERE organization_id = ${orgId} AND refund_number = '8001'`);
    assertEq(`${refund.status} ${refund.ref} ${Number(refund.total)}`, "posted 1049 16.2", "refund");
  });

  await check("payments apply as QuickBooks applied them; an overpayment stays as credit", async () => {
    const bal = async (qboId: string) => {
      const [r] = await db.execute<{ b: string }>(sql`SELECT ${customerBalanceSql(sql`${await localId("Customer", qboId)}::uuid`)}::text AS b`);
      return Number(r.b);
    };
    assertEq(await bal("1"), 0, "Amy: paid by cash and a credit memo");
    assertEq(await bal("2"), -74, "Bill's: 49 overpaid + 25 credit memo left");
    assertEq(await bal("4"), 50, "Bad Email Co: 50 still open");
    const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ar_payments WHERE organization_id = ${orgId} AND status = 'voided'`);
    assertEq(n, 1, "voided payment kept, voided");
    const [app] = await db.execute<{ amount: string }>(sql`SELECT amount::text FROM ar_credit_applications WHERE organization_id = ${orgId}`);
    assertEq(Number(app.amount), 50, "credit memo applied inside the payment");
  });

  await check("deposits move payments and receipts out of Undeposited Funds", async () => {
    const lines = await db.execute<{ payment: string | null; receipt: string | null; amount: string }>(sql`
      SELECT l.ar_payment_id AS payment, l.sales_receipt_id AS receipt, l.amount::text FROM bank_transaction_lines l
        JOIN bank_transactions t ON t.id = l.transaction_id WHERE t.organization_id = ${orgId} AND t.type = 'deposit' AND t.vendor_id IS NULL
       ORDER BY l.line_number`);
    assert(lines.some((l) => l.payment), "a payment line");
    assert(lines.some((l) => l.receipt), "a sales receipt line");
    assert(lines.some((l) => Number(l.amount) === -20), "cash back");
    assertEq(await balance(await qboAccount("4")), 200, "Undeposited Funds holds the one payment not deposited");
  });

  section("Purchase history");
  await check("bills come in posted, with tags; negative lines credit their account", async () => {
    const bills = await db.execute<{ ref: string; status: string; num: string }>(sql`
      SELECT vendor_invoice_number AS ref, status, bill_number AS num FROM ap_bills WHERE organization_id = ${orgId} ORDER BY vendor_invoice_number`);
    assertEq(bills.map((b) => `${b.ref}:${b.status}`).join(", "), "B-7:paid, H-100:paid, H-101:posted", "statuses after payments");
    assert(bills.every((b) => b.num.startsWith("BILL-")), "Groundworks bill numbers; QuickBooks' kept as the vendor's");
    const [tagged] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ap_bill_lines l JOIN ap_bills b ON b.id = l.bill_id
       WHERE b.organization_id = ${orgId} AND b.vendor_invoice_number = 'H-100' AND jsonb_array_length(l.dimensions) = 2`);
    assertEq(tagged.n, 2, "class and department on both lines");
    assertEq(await balance(await qboAccount("19")), 245, "Office Supplies: 300 − 50 − 40 + 20 − 30 + 45");
    const old = await db.select().from(accounts).where(and(eq(accounts.organizationId, orgId), eq(accounts.name, "Old Expense")));
    assertEq(await balance(old[0].id), 200, "history on an inactive account");
    assertEq(old[0].isActive, false, "and it ends inactive");
  });

  await check("bill payments use vendor credits; a prepayment is a check against Accounts Payable", async () => {
    const [vc] = await db.execute<{ status: string }>(sql`SELECT status FROM vendor_credits WHERE organization_id = ${orgId}`);
    assertEq(vc.status, "applied", "vendor credit used up");
    const pays = await db.execute<{ status: string; ref: string | null; method: string; net: string }>(sql`
      SELECT status, reference AS ref, method, net_amount::text AS net FROM ap_payments WHERE organization_id = ${orgId} ORDER BY payment_date`);
    assertEq(pays.map((p) => `${p.status}:${p.ref ?? ""}:${p.method}:${Number(p.net)}`).join(", "), "posted:1050:check:1335, posted::credit_card:200, voided:1051:check:0", "payments");
    assert((await notes()).some((x) => x.includes("50.00 wasn't applied to a bill") && x.includes("card charge")), "prepayment noted");
    assertEq(await balance(await qboAccount("3")), -100, "AP owes 100: bills 1825 − credits and payments 1625 − JE 100");
  });

  await check("expenses, checks, card charges and credits, and transfers", async () => {
    const txns = await db.execute<{ type: string; ref: string | null; payee: string | null; status: string; total: string }>(sql`
      SELECT type, reference AS ref, payee_name AS payee, status, total_amount::text AS total FROM bank_transactions WHERE organization_id = ${orgId}`);
    assert(txns.some((t) => t.type === "check" && t.ref === "1052" && t.status === "posted"), "check with its number");
    assert(txns.some((t) => t.type === "check" && t.ref === "1053" && t.status === "voided"), "voided check kept");
    assert(txns.some((t) => t.type === "deposit" && Number(t.total) === 30), "card credit is money back on the card");
    assert(txns.some((t) => t.payee === "Pat Smith"), "employee payee by name");
    assertEq(await balance(await qboAccount("17")), 300, "Savings got the transfer");
    assertEq(await balance(await qboAccount("15")), -300, "Visa owes 300: −240 + 30 − 200 − 50 + 200 − 40");
    assertEq(await balance(await qboAccount("1")), -1321.8, "Checking");
  });

  await check("inventory moves with the history, costs FIFO, then matches QuickBooks' stock on hand", async () => {
    const rock = await localId("Item", "2");
    const [sale] = await db.execute<{ cost: string }>(sql`
      SELECT cost::text FROM inventory_movements WHERE item_id = ${rock} AND source_type = 'ar_invoice' AND voided_at IS NULL`);
    assertEq(Number(sale.cost), 125, "the sale took the oldest unit (FIFO)");
    const [s] = await db.execute<{ q: string; v: string }>(sql`
      SELECT coalesce(sum(quantity), 0)::text AS q, coalesce(sum(CASE WHEN quantity > 0 THEN cost ELSE -cost END), 0)::text AS v
        FROM inventory_movements WHERE item_id = ${rock} AND voided_at IS NULL`);
    assertEq(`${Number(s.q)} ${Number(s.v)}`, "5 610", "QuickBooks' 5 units worth 610 (history here gave 4 worth 490)");
    const [adj] = await db.execute<{ memo: string; date: string }>(sql`
      SELECT memo, adjustment_date::text AS date FROM inventory_adjustments WHERE organization_id = ${orgId}`);
    assert(adj?.memo.includes("Matches stock on hand to QuickBooks"), "a labeled adjustment");
    assertEq(adj.date, new Date().toISOString().slice(0, 10), "dated the import day");
    assert((await notes()).some((x) => x.startsWith("Rock Fountain: 4 on hand worth 490.00 here, 5 worth 610.00 in QuickBooks")), "noted");
    assertEq(await balance(await qboAccount("5")), 610, "Inventory Asset ties to the stock");
    assertEq(await balance(await qboAccount("11")), 5, "COGS: 125 sold + 490 out − 610 back in");
  });

  section("Estimates and purchase orders");
  await check("estimates keep their status and totals; the invoice that billed one points at it", async () => {
    const rows = await db.execute<{ id: string; n: string; status: string; total: string; tax: string; expires: string | null }>(sql`
      SELECT id, estimate_number AS n, status, total_amount::text AS total, tax_amount::text AS tax, expiration_date::text AS expires
        FROM estimates WHERE organization_id = ${orgId} ORDER BY estimate_number`);
    assertEq(rows.map((r) => `${r.n}:${r.status}:${Number(r.total)}`).join(", "), "3001:closed:150, 3002:pending:162", "estimates");
    assertEq(`${Number(rows[1].tax)} ${rows[1].expires}`, "12 2026-05-10", "tax and expiry");
    const [inv] = await db.execute<{ e: string | null }>(sql`SELECT estimate_id AS e FROM ar_invoices WHERE organization_id = ${orgId} AND invoice_number = '1001'`);
    assertEq(inv.e, rows[0].id, "invoice 1001 billed estimate 3001");
  });

  await check("purchase orders come across approved; bill lines point at the lines they billed", async () => {
    const pos = await db.execute<{ id: string; n: string; status: string; total: string; msg: string | null; lines: number }>(sql`
      SELECT p.id, p.po_number AS n, p.status, p.total_amount::text AS total, p.vendor_message AS msg,
             (SELECT count(*)::int FROM purchase_order_lines l WHERE l.purchase_order_id = p.id) AS lines
        FROM purchase_orders p WHERE p.organization_id = ${orgId} ORDER BY p.po_number`);
    assertEq(pos.map((p) => `${p.n}:${p.status}:${Number(p.total)}:${p.lines}`).join(", "), "4001:closed:1375:2, 4002:open:80:1", "purchase orders");
    assertEq(pos[1].msg, "Deliver to the back door", "message to the vendor");
    assert((await notes()).some((x) => x.startsWith("Purchase order 4002: lines of zero or less")), "zero line noted");
    const [bill] = await db.execute<{ po: string | null; linked: number }>(sql`
      SELECT b.purchase_order_id AS po, (SELECT count(*)::int FROM ap_bill_lines l WHERE l.bill_id = b.id AND l.purchase_order_line_id IS NOT NULL) AS linked
        FROM ap_bills b WHERE b.organization_id = ${orgId} AND b.vendor_invoice_number = 'H-100'`);
    assertEq(`${bill.po === pos[0].id} ${bill.linked}`, "true 2", "bill H-100 billed PO 4001, line by line");
  });

  await check("tax, income, AR, and the trial balance tie to the hand-worked figures", async () => {
    assertEq(await balance(await qboAccount("14")), -29.2, "Sales tax payable: 22 + 4.80 + 1.20 + 2.40 − 1.20");
    assertEq(await balance(await qboAccount("8")), -360, "Sales of Product Income (shipping falls back here)");
    assertEq(await balance(await qboAccount("9")), -725, "Services: design lines, credits, the deposit line, JE");
    assertEq(await balance(await qboAccount("2")), 226, "AR: 738 − 75 − 687 + JE 250");
    const [tb] = await db.execute<{ dr: string; cr: string }>(sql`
      SELECT sum(l.debit)::text AS dr, sum(l.credit)::text AS cr FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id WHERE j.organization_id = ${orgId}`);
    assertEq(tb.dr, tb.cr, "debits equal credits");
  });

  section("Cleared and reconciled");
  await check("QuickBooks' reconciled lines form a completed reconciliation; cleared ones stay cleared", async () => {
    const checking = await qboAccount("1");
    const recs = await db.execute<{ end: string; bal: string; n: number }>(sql`
      SELECT statement_end_date::text AS end, statement_ending_balance::text AS bal, cleared_count AS n FROM reconciliations
       WHERE account_id = ${checking} AND status = 'completed'`);
    assertEq(recs.length, 1, "one reconciliation");
    assertEq(`${recs[0].end} ${Number(recs[0].bal)} ${recs[0].n}`, "2026-03-23 699.4 4", "through the last reconciled date: 1000 − 500 + 499.40 − 300");
    const [c] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM gl_line_clearings WHERE account_id = ${checking} AND status = 'cleared'`);
    assertEq(c.n, 2, "two cleared, not reconciled");
    const [visa] = await db.execute<{ bal: string }>(sql`
      SELECT statement_ending_balance::text AS bal FROM reconciliations WHERE account_id = ${await qboAccount("15")} AND status = 'completed'`);
    assertEq(Number(visa.bal), 240, "card: amount owed");
    assert((await notes()).some((x) => x.startsWith("Checking: 1 cleared or reconciled")), "a transaction that isn't here is noted");
    const sheet = await runAs(as(), (ctx) => reconcile.startReconciliation(ctx, { accountId: checking, statementEndDate: "2026-04-30", statementEndingBalance: "0" }));
    assertEq(Number(sheet.beginningBalance), 699.4, "the next reconciliation starts where QuickBooks' ended");
    await runAs(as(), (ctx) => reconcile.cancelReconciliation(ctx, { id: sheet.id }));
  });

  section("Finishing");
  await check("invoice numbers continue QuickBooks' series; mixed ones keep Groundworks'", async () => {
    const [inv] = await db.execute<{ prefix: string; last: number; width: number }>(sql`
      SELECT prefix, last_used_number AS last, width FROM number_series WHERE organization_id = ${orgId} AND code = 'INV'`);
    assertEq(`${inv.prefix}|${inv.last}|${inv.width}`, "|1004|4", "next invoice is 1005");
    const others = await db.execute<{ code: string; last: number }>(sql`
      SELECT code, last_used_number AS last FROM number_series WHERE organization_id = ${orgId} AND code IN ('EST', 'PO') ORDER BY code`);
    assertEq(others.map((o) => `${o.code}:${o.last}`).join(", "), "EST:3002, PO:4002", "estimates and purchase orders continue too");
    assert((await notes()).some((x) => x.startsWith("Credit memo numbers didn't all come across as plain numbers")), "credit memos keep CM-");
  });

  section("Tie-out with QuickBooks");
  const SIDE_DEBIT = new Set(["cash", "receivables", "inventory", "other_current_asset", "fixed_assets", "other_asset", "cogs_materials", "cogs_labor", "cogs_equipment", "cogs_subcontractor", "cogs_other", "operating_expense", "sga", "interest", "tax", "other_expense"]);
  await check("QuickBooks' books by month come across; only the real differences show", async () => {
    await expectError(() => runAs(asAgent(), (ctx) => tieout.refreshTieout(ctx)), "forbidden");
    assertEq((await runAs(as("viewer"), (ctx) => tieout.getTieout(ctx))).ready, false, "not compared yet");
    // QuickBooks' books: everything that came across, plus what its API doesn't show.
    const ours = await db.execute<{ qbo: string; month: string; net: string; sub: string; code: string }>(sql`
      SELECT m.qbo_id AS qbo, to_char(date_trunc('month', j.journal_date), 'YYYY-MM') AS month, sum(l.debit_local - l.credit_local)::text AS net,
             a.subcategory AS sub, a.code
        FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
        JOIN qbo_id_map m ON m.local_id = a.id AND m.entity = 'Account' AND m.organization_id = ${orgId}
       WHERE j.organization_id = ${orgId} AND j.status IN ('posted', 'reversed')
       GROUP BY 1, 2, 4, 5`);
    fake.state.books = [
      ...ours.map((r) => ({ account: r.qbo, month: r.month, amount: Number(r.net) * (SIDE_DEBIT.has(r.sub) ? 1 : -1) })),
      // A sales tax payment (QuickBooks' API doesn't share them).
      { account: "14", month: "2026-03", amount: -20 },
      { account: "1", month: "2026-03", amount: -20 },
      // A bank fee booked to supplies.
      { account: "19", month: "2026-04", amount: 5 },
      { account: "1", month: "2026-04", amount: -5 },
      // An account that never came across.
      { account: "77", name: "Ask My Accountant", kind: "pl" as const, month: "2026-05", amount: 12 },
      { account: "1", month: "2026-05", amount: -12 },
    ];
    const t = await runAs(as(), (ctx) => tieout.refreshTieout(ctx));
    assert(t.ready && t.monthsCompared >= 7, `compared ${t.monthsCompared} months`);
    assertEq(t.months.map((m) => m.month).join(", "), "2026-03, 2026-04, 2026-05", "only the months that differ");
    const march = t.months[0].lines.map((l) => `${l.code}:${Number(l.difference)}`).join(", ");
    assertEq(march, "1010:-20, 2200:-20", "March: the tax payment, on each account's side");
    const may = t.months[2];
    assert(may.lines.some((l) => l.accountId === null && l.name === "Ask My Accountant"), "an account that didn't come across shows by its QuickBooks name");
    assert(fake.state.queries.some((q) => q.startsWith("report BalanceSheet 2026-07-01")), "read a year at a time, balances carried across");
    const agentView = await runAs(asAgent(), (ctx) => tieout.getTieout(ctx));
    assertEq(agentView.months.length, 3, "agents can read it");
  });

  await check("an admin posts the entries that close the differences; agents and viewers can't", async () => {
    await expectError(() => runAs(asAgent(), (ctx) => tieout.postTieoutEntries(ctx, { month: "2026-03" })), "forbidden");
    await expectError(() => runAs(as("bookkeeper"), (ctx) => tieout.postTieoutEntries(ctx, { month: "2026-03" })), "forbidden");
    let t = await runAs(as("admin"), (ctx) => tieout.postTieoutEntries(ctx, { month: "2026-03" }));
    assertEq(t.months.map((m) => m.month).join(", "), "2026-04, 2026-05", "March ties now");
    const lines = await db.execute<{ code: string; dr: string; cr: string; date: string; source: string }>(sql`
      SELECT a.code, l.debit::text AS dr, l.credit::text AS cr, j.journal_date::text AS date, j.source FROM gl_lines l
        JOIN gl_journals j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
       WHERE j.organization_id = ${orgId} AND j.document_no = 'TIEOUT-2026-03' ORDER BY a.code`);
    assertEq(lines.map((l) => `${l.code} ${Number(l.dr)}/${Number(l.cr)}`).join(", "), "1010 0/20, 2200 20/0", "Dr Sales Tax Payable / Cr Checking");
    assertEq(`${lines[0].date} ${lines[0].source}`, "2026-03-31 conversion", "a conversion entry on the month's last day");
    t = await runAs(as("admin"), (ctx) => tieout.postTieoutEntries(ctx, {}));
    assertEq(t.months.map((m) => m.month).join(", "), "2026-05", "only the account that didn't come across is left");
    assertEq(t.months[0].postable, false, "nothing left to post there");
    assert(t.months[0].lines.some((l) => l.code === "3300" && Number(l.difference) === 12), "Opening Balance Equity holds it");
    await expectError(() => runAs(as("admin"), (ctx) => tieout.postTieoutEntries(ctx, {})), "invalid_state");
    assertEq(await balance(await qboAccount("1")), -1358.8, "Checking: −1321.80 − 20 − 5 − 12");
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, orgId), eq(auditLog.event, "qbo.tieout.posted")));
    assert(a, "audited");
  });

  section("Reconnect and disconnect");
  await check("reconnecting needs the same QuickBooks company and a person", async () => {
    await expectError(() => runAs(as(), (ctx) => qbo.reconnect(ctx, { code: GOOD_CODE, realmId: "other" })), "invalid_input");
    await expectError(() => runAs(asAgent(), (ctx) => qbo.reconnect(ctx, { code: GOOD_CODE, realmId: REALM })), "forbidden");
    await runAs(as(), (ctx) => qbo.reconnect(ctx, { code: GOOD_CODE, realmId: REALM }));
    const [conn] = await db.select().from(qboConnections).where(eq(qboConnections.organizationId, orgId));
    assertEq(unseal(conn.refreshToken!), fake.state.refreshToken, "new tokens");
  });

  await check("disconnecting revokes at Intuit, forgets the tokens, and keeps the books", async () => {
    await expectError(() => runAs(as("bookkeeper"), (ctx) => qbo.disconnectQuickBooks(ctx)), "forbidden");
    const rt = fake.state.refreshToken;
    await runAs(as("admin"), (ctx) => qbo.disconnectQuickBooks(ctx));
    assert(fake.state.revoked.includes(rt), "revoked at Intuit");
    const [conn] = await db.select().from(qboConnections).where(eq(qboConnections.organizationId, orgId));
    assertEq(conn.refreshToken, null, "refresh token gone");
    assertEq(conn.accessToken, null, "access token gone");
    assert(conn.disconnectedAt, "disconnected at");
    const v = await view();
    assertEq(v.connection?.connected, false, "shows disconnected");
    assertEq(v.status, "done", "import still done");
    const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM gl_journals WHERE organization_id = ${orgId}`);
    assert(n > 30, `books kept (${n} journals)`);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, orgId), eq(auditLog.event, "qbo.disconnected")));
    assert(a, "audited");
  });

  await check("an unfinished import can't run while disconnected", async () => {
    await db.update(qboImports).set({ status: "running", cursor: { step: "journal_entries", position: 1 } }).where(eq(qboImports.organizationId, orgId));
    await expectError(() => batch(20_000), "invalid_state");
  });

  await check("a company that wasn't imported says so", async () => {
    const [first] = await db.select().from(organizations).where(eq(organizations.name, `${PREFIX} First Co`));
    const v = await runAs(userActor({ organizationId: first.id, userId: owner.id, role: "owner" }), (ctx) => qbo.getImportStatus(ctx));
    assertEq(v.status, "none", "none");
    assertEq(v.connection, null, "no connection");
  });

  await fake.close();
  await deleteOrgs(PREFIX);
  await db.execute(sql`DELETE FROM auth.users WHERE email LIKE ${`%-${stamp}@example.com`}`);
}

main()
  .then(() => finish())
  .catch(async (e) => {
    console.error(e);
    await deleteOrgs(PREFIX).catch(() => undefined);
    process.exit(1);
  });
