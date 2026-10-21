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
import { toAppError } from "../src/lib/errors";
import { getCompanyProfile } from "../src/lib/company/profile";
import { checkState, startAuthorization, STATE_COOKIE } from "../src/lib/qbo/oauth";
import * as qbo from "../src/lib/qbo/service";
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
       WHERE j.organization_id = ${orgId} ORDER BY j.journal_date`);
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

  await check("balances tie to QuickBooks; the ones that couldn't post are noted", async () => {
    const [bal] = await db.execute<{ checking: string; dr: string; cr: string }>(sql`
      SELECT
        sum(CASE WHEN l.account_id = ${await localId("Account", "1")} THEN l.debit - l.credit ELSE 0 END)::text AS checking,
        sum(l.debit)::text AS dr, sum(l.credit)::text AS cr
        FROM gl_lines l JOIN gl_journals j ON j.id = l.journal_id WHERE j.organization_id = ${orgId}`);
    assertEq(Number(bal.checking), 400, "checking 1000 − 500 − 100");
    assertEq(bal.dr, bal.cr, "debits equal credits");
    const n = await notes();
    assert(n.some((x) => x.startsWith("Journal entry JE-5") && x.includes("isn't in the chart")), "unknown account noted");
    assert(n.some((x) => x.startsWith("Journal entry JE-6") && x.includes("didn't post")), "unbalanced noted");
    const je = (await view()).steps.find((s) => s.key === "journal_entries")!;
    assertEq(je.imported, 5, "imported");
    assertEq(je.skipped, 3, "skipped (unknown account, unbalanced, empty)");
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
    assertEq(n, 5, "books kept");
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
