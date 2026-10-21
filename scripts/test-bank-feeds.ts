/**
 * End-to-end: bank feeds, against a fake Plaid (scripts/lib/fake-plaid.ts).
 * Who may connect; connecting (sealed token); linking accounts and where
 * each starts (after the last reconciliation or imported statement, else 90
 * days back); syncing posted transactions only into For review with the
 * sign flipped, rules applied, and no duplicates; the bank's edits and
 * removals before and after review; paging and a restart mid-read; a bank
 * that wants its sign-in again, and reconnecting; signed webhooks; the daily
 * run; agents; another company; disconnecting; the page's CSP.
 *
 *   npx tsx scripts/test-bank-feeds.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { randomBytes } from "node:crypto";
import { format, subDays } from "date-fns";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, bankFeedAccounts, bankFeedConnections, bankStatementImports, bankStatementLines } from "../src/lib/db/schema";
import { runAs, systemActor, type Actor } from "../src/lib/actor";
import { OPERATIONS } from "../src/lib/api/operations";
import { plaidConfigured } from "../src/lib/banking/feeds/plaid";
import * as feeds from "../src/lib/banking/feeds/service";
import { verifyPlaidWebhook } from "../src/lib/banking/feeds/webhook";
import * as rec from "../src/lib/banking/reconcile";
import * as review from "../src/lib/banking/review";
import * as rules from "../src/lib/banking/rules";
import { contentSecurityPolicy } from "../src/lib/security/headers";
import { unseal } from "../src/lib/security/crypto";
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_SECRET, startFakePlaid, type FakeTxn } from "./lib/fake-plaid";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

const today = new Date();
const daysAgo = (n: number) => format(subDays(today, n), "yyyy-MM-dd");

async function main() {
  const fake = await startFakePlaid();
  Object.assign(process.env, {
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PLAID_CLIENT_ID: FAKE_PLAID_CLIENT_ID,
    PLAID_SECRET: FAKE_PLAID_SECRET,
    PLAID_ENV: "sandbox",
    PLAID_API_BASE: fake.url,
    PLAID_LINK_SCRIPT_URL: `${fake.url}/link-initialize.js`,
    NEXT_PUBLIC_APP_URL: "http://localhost:3100",
  });

  const t = await createTestOrg("feeds-test-");
  const other = await createTestOrg("feeds-other-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const agent: Actor = { ...t.as("bookkeeper"), kind: "agent", userId: null, agentId: null, agentName: "Feed bot", scopes: ["read", "write"] };
  const agentAdmin: Actor = { ...t.as("admin"), kind: "agent", userId: null, agentId: null, agentName: "Admin bot" };
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const checking = account(t, "1010");
  const savings = account(t, "1020");
  const card = account(t, "2100");
  const fees = account(t, "6100");
  const supplies = account(t, "6620");
  const rent = account(t, "6600");

  const txn = (id: string, account_id: string, amount: number, date: string, name: string, extra: Partial<FakeTxn> = {}): FakeTxn => ({
    transaction_id: id,
    account_id,
    amount,
    date,
    name,
    merchant_name: name.split(" ")[0],
    pending: false,
    ...extra,
  });
  const lineFor = async (transactionId: string) => {
    const [l] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.organizationId, t.org.id), eq(bankStatementLines.fitId, `plaid:${transactionId}`)));
    return l;
  };
  const feedLines = async (accountId: string) => {
    const [r] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM bank_statement_lines l JOIN bank_statement_imports i ON i.id = l.import_id WHERE l.account_id = ${accountId} AND i.format = 'feed'`
    );
    return r.n;
  };
  const audits = async (event: string) =>
    (await db.select().from(auditLog).where(and(eq(auditLog.organizationId, t.org.id), eq(auditLog.event, event)))).length;

  section("Who may connect");
  await check("bank feeds are configured from PLAID_CLIENT_ID and PLAID_SECRET; without them, connecting says so", async () => {
    assert(plaidConfigured(), "configured");
    const keep = process.env.PLAID_SECRET;
    delete process.env.PLAID_SECRET;
    try {
      assert(!plaidConfigured(), "not configured");
      await expectError(() => run(admin, (ctx) => feeds.createLinkToken(ctx)), "invalid_state");
    } finally {
      process.env.PLAID_SECRET = keep;
    }
  });
  await check("only people (admins and owners) open Plaid's sign-in; it asks for transactions, two years back, with the webhook", async () => {
    await expectError(() => run(bookkeeper, (ctx) => feeds.createLinkToken(ctx)), "forbidden");
    await expectError(() => run(agentAdmin, (ctx) => feeds.createLinkToken(ctx)), "forbidden");
    const r = await run(admin, (ctx) => feeds.createLinkToken(ctx));
    assert(r.linkToken.startsWith("link-sandbox-"), r.linkToken);
    assertEq(r.scriptUrl, `${fake.url}/link-initialize.js`, "script");
    const asked = fake.state.linkTokens.at(-1)!.body;
    assertEq(JSON.stringify(asked.products), '["transactions"]', "products");
    assertEq((asked.transactions as { days_requested: number }).days_requested, 730, "days requested");
    assertEq(asked.webhook, "http://localhost:3100/api/webhooks/plaid", "webhook");
    assertEq((asked.user as { client_user_id: string }).client_user_id, t.owner.id, "Plaid's user is the person");
    assert(!("access_token" in asked), "not update mode");
  });

  section("Connecting a bank");
  const login = fake.signIn();
  const itemId = login.itemId;
  fake.add(
    itemId,
    txn("c-old", "acc-checking", 50, "2026-03-15", "Old charge already on the statement"),
    txn("c1", "acc-checking", -1500, "2026-03-25", "Customer deposit ACH"),
    txn("c2", "acc-checking", 15, "2026-03-26", "MONTHLY SERVICE FEE"),
    txn("c3", "acc-checking", 89.4, "2026-03-27", "Office Depot #1234", { check_number: null }),
    txn("c-pend", "acc-checking", 20, "2026-03-28", "Comcast Business", { pending: true }),
    txn("s-old", "acc-savings", -10, "2026-04-15", "Interest before the reconciliation"),
    txn("s1", "acc-savings", -0.42, "2026-05-05", "Interest payment"),
    txn("k-old", "acc-card", 5, daysAgo(120), "Long ago coffee"),
    txn("k1", "acc-card", 42.15, daysAgo(10), "Shell Oil 5678"),
    txn("k-refund", "acc-card", -20, daysAgo(5), "Amazon refund")
  );
  let conn!: feeds.BankFeedView;
  await check("connecting keeps the bank's accounts, ready to link, and the access token sealed", async () => {
    await expectError(() => run(bookkeeper, (ctx) => feeds.connectBank(ctx, { publicToken: login.publicToken })), "forbidden");
    const list = await run(admin, (ctx) =>
      feeds.connectBank(ctx, { publicToken: login.publicToken, institutionName: "First Platypus Bank", institutionId: "ins_109508" })
    );
    assertEq(list.length, 1, "one connection");
    conn = list[0];
    assertEq(conn.status, "active", "status");
    assertEq(conn.institutionName, "First Platypus Bank", "institution");
    assertEq(conn.accounts.length, 3, "accounts");
    assert(conn.accounts.every((a) => a.accountId === null), "nothing linked yet");
    assertEq(conn.accounts.find((a) => a.mask === "3333")?.subtype, "credit card", "card subtype");
    const [row] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assertEq(row.itemId, itemId, "item id");
    assert(row.accessToken && !row.accessToken.includes("access-sandbox"), "sealed");
    assertEq(unseal(row.accessToken), fake.state.items.get(itemId)!.accessToken, "opens to Plaid's token");
    assertEq(await audits("bank.feed.connected"), 1, "audited");
  });
  await check("a public token works once, and another company can't take a bank login that's connected here", async () => {
    await expectError(() => run(admin, (ctx) => feeds.connectBank(ctx, { publicToken: login.publicToken })), "upstream_error");
    const again = fake.publicTokenFor(itemId);
    await expectError(() => other.run(other.as("admin"), (ctx) => feeds.connectBank(ctx, { publicToken: again })), "conflict");
  });
  const feedAcct = (mask: string) => conn.accounts.find((a) => a.mask === mask)!.id;

  section("Linking accounts and where each starts");
  await check("before anything is linked, a sync brings nothing in", async () => {
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.added, 0, "added");
  });
  await check("checking starts the day after its last imported statement line", async () => {
    const csv = ["Date,Description,Amount", "03/10/2026,DEPOSIT,100.00", "03/20/2026,OLD CHARGE,-50.00"].join("\n");
    await run(bookkeeper, (ctx) => review.importStatement(ctx, { accountId: checking.id, content: csv, fileName: "march.csv" }));
    await expectError(() => run(bookkeeper, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("0000"), accountId: checking.id })), "forbidden");
    const list = await run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("0000"), accountId: checking.id }));
    const a = list[0].accounts.find((x) => x.mask === "0000")!;
    assertEq(a.accountId, checking.id, "linked");
    assertEq(a.startDate, "2026-03-21", "start");
    assertEq(a.accountCode, "1010", "code shown");
  });
  await check("savings starts the day after its last completed reconciliation", async () => {
    const sheet = await run(accountant, (ctx) => rec.startReconciliation(ctx, { accountId: savings.id, statementEndDate: "2026-04-30", statementEndingBalance: "0" }));
    await run(accountant, (ctx) => rec.completeReconciliation(ctx, { id: sheet.id }));
    const list = await run(owner, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("1111"), accountId: savings.id }));
    assertEq(list[0].accounts.find((x) => x.mask === "1111")!.startDate, "2026-05-01", "start");
  });
  await check("a card with no history starts 90 days back", async () => {
    const list = await run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("3333"), accountId: card.id }));
    assertEq(list[0].accounts.find((x) => x.mask === "3333")!.startDate, daysAgo(90), "start");
  });
  await check("feeds go only to reconcilable bank and card accounts, one feed per account", async () => {
    await expectError(() => run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("3333"), accountId: rent.id })), "invalid_input");
    await expectError(() => run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("3333"), accountId: checking.id })), "conflict");
    assertEq(await audits("bank.feed.account_linked"), 3, "each link audited");
  });

  section("Syncing into For review");
  await check("rules for the lines to come", async () => {
    await run(admin, (ctx) =>
      rules.createBankRule(ctx, { name: "Bank fees", conditions: [{ field: "description", op: "contains", value: "service fee" }], direction: "money_out", categoryAccountId: fees.id, autoAdd: true })
    );
    await run(admin, (ctx) => rules.createBankRule(ctx, { name: "Office supplies", conditions: [{ field: "description", op: "contains", value: "office depot" }], categoryAccountId: supplies.id }));
  });
  await check("a sync brings posted transactions from each account's start, signs flipped, rules applied", async () => {
    await expectError(() => run(viewer, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id })), "forbidden");
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.status, "active", "status");
    assertEq(r.added, 6, "c1 c2 c3 s1 k1 k-refund");
    assertEq(r.rules.autoAdded, 1, "the service fee added by its rule");
    assert(r.rules.categorized >= 1, "office depot categorized");
    assertEq((await lineFor("c1")).amount, "1500.0000", "money in is positive");
    assertEq((await lineFor("c3")).amount, "-89.4000", "money out is negative");
    assertEq((await lineFor("k1")).amount, "-42.1500", "a card charge is money out");
    assertEq((await lineFor("k-refund")).amount, "20.0000", "a card refund is money in");
    assertEq((await lineFor("s1")).amount, "0.4200", "interest");
    assertEq((await lineFor("c3")).ruleId !== null, true, "rule noted");
    assertEq((await lineFor("c3")).payee, "Office", "payee from the merchant");
    assertEq((await lineFor("c2")).status, "added", "auto-added");
    for (const skipped of ["c-old", "c-pend", "s-old", "k-old"]) assertEq(await lineFor(skipped), undefined, `${skipped} not in`);
    const imports = await db.select().from(bankStatementImports).where(and(eq(bankStatementImports.accountId, checking.id), eq(bankStatementImports.format, "feed")));
    assertEq(imports.length, 1, "one feed import for checking");
    assertEq(imports[0].fileName, "First Platypus Bank · Plaid Checking ••0000", "named for the feed");
    const [row] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assert(row.lastSyncedAt, "last synced");
    assert(row.cursor?.startsWith("c"), "cursor saved");
    assertEq(await audits("bank.feed.synced"), 2, "audited");
  });
  await check("syncing again brings nothing new", async () => {
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.added + r.updated + r.removed, 0, "nothing");
  });
  await check("when a pending transaction posts, it comes in once", async () => {
    fake.remove(itemId, { transaction_id: "c-pend", account_id: "acc-checking" });
    fake.add(itemId, txn("c-posted", "acc-checking", 20, "2026-03-29", "Comcast Business"));
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.added, 1, "added");
    assertEq(r.removed, 0, "the pending one never came in");
    assertEq((await lineFor("c-posted")).amount, "-20.0000", "amount");
  });

  section("The bank's edits and removals");
  await check("an edit to a line still in For review follows the bank; one already reviewed stays and is counted", async () => {
    const c1 = await lineFor("c1");
    await run(bookkeeper, (ctx) => review.excludeStatementLine(ctx, { id: c1.id }));
    fake.modify(itemId, txn("c3", "acc-checking", 98.4, "2026-03-27", "Office Depot #1234"), txn("c1", "acc-checking", -1600, "2026-03-25", "Customer deposit ACH"));
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.updated, 1, "updated");
    assertEq(r.changedAfterReview, 1, "changed after review");
    assertEq((await lineFor("c3")).amount, "-98.4000", "follows the bank");
    assertEq((await lineFor("c1")).amount, "1500.0000", "reviewed line left as is");
  });
  await check("a removal takes a waiting line out; one already added to the books stays", async () => {
    fake.remove(itemId, { transaction_id: "k-refund", account_id: "acc-card" }, { transaction_id: "c2", account_id: "acc-checking" });
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.removed, 1, "removed");
    assertEq(r.changedAfterReview, 1, "the added one");
    assertEq(await lineFor("k-refund"), undefined, "gone");
    assertEq((await lineFor("c2")).status, "added", "still in the books");
  });

  section("Paging, restarts, relinking");
  await check("relinking reads the bank again in pages, restarts once when the bank changes mid-read, and adds no duplicates", async () => {
    const before = await feedLines(card.id);
    await run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("3333"), accountId: null }));
    const unlinked = await run(viewer, (ctx) => feeds.listBankFeeds(ctx));
    assertEq(unlinked[0].accounts.find((x) => x.mask === "3333")!.accountId, null, "unlinked");
    await run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("3333"), accountId: card.id }));
    fake.state.pageSize = 2;
    fake.state.mutateOnce = true;
    const callsBefore = fake.state.calls.filter((c) => c === "/transactions/sync").length;
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    const calls = fake.state.calls.filter((c) => c === "/transactions/sync").length - callsBefore;
    assert(calls >= 5, `read in pages, with a restart (${calls} calls)`);
    assert(!fake.state.mutateOnce, "the restart happened");
    assertEq(r.added, 0, "nothing new");
    assertEq(await feedLines(card.id), before, "no duplicates");
    fake.state.pageSize = 500;
  });

  section("Sign-in again, and reconnecting");
  await check("a bank that wants its sign-in again marks the feed; the daily run skips it", async () => {
    fake.setLoginRequired(itemId, true);
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.status, "login_required", "status");
    assert(r.error?.includes("sign in again"), r.error ?? "");
    const [row] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assertEq(row.status, "login_required", "saved");
    const daily = await feeds.runBankFeedsForOrg(t.org.id);
    assertEq(daily.checked, 0, "skipped");
  });
  await check("reconnecting opens Plaid's window for that login, then the feed works again", async () => {
    await expectError(() => run(bookkeeper, (ctx) => feeds.createLinkToken(ctx, { connectionId: conn.id })), "forbidden");
    await run(admin, (ctx) => feeds.createLinkToken(ctx, { connectionId: conn.id }));
    const asked = fake.state.linkTokens.at(-1)!.body;
    assertEq(asked.access_token, fake.state.items.get(itemId)!.accessToken, "update mode");
    assert(!("products" in asked), "no products in update mode");
    fake.setLoginRequired(itemId, false);
    const list = await run(admin, (ctx) => feeds.markReconnected(ctx, { id: conn.id }));
    assertEq(list[0].status, "active", "active");
    fake.add(itemId, txn("c4", "acc-checking", 12, "2026-04-02", "Coffee"));
    const r = await run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.added, 1, "flowing again");
  });

  section("Webhooks");
  await check("a webhook is believed only when signed, fresh, and for this exact body", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId });
    assert(await verifyPlaidWebhook(body, fake.signWebhook(body)), "good");
    assert(!(await verifyPlaidWebhook(body.replace("SYNC", "SINK"), fake.signWebhook(body))), "body changed");
    assert(!(await verifyPlaidWebhook(body, fake.signWebhook(body, { iat: Math.floor(Date.now() / 1000) - 600 }))), "ten minutes old");
    assert(!(await verifyPlaidWebhook(body, fake.signWebhook(body, { bodyHash: "0".repeat(64) }))), "another body's hash");
    assert(!(await verifyPlaidWebhook(body, null)), "no header");
    assert(!(await verifyPlaidWebhook(body, "not.a.jwt")), "garbage");
    const [h, p, s] = fake.signWebhook(body).split(".");
    const otherKid = Buffer.from(JSON.stringify({ alg: "ES256", kid: "nope" })).toString("base64url");
    assert(!(await verifyPlaidWebhook(body, `${otherKid}.${p}.${s}`)), "unknown key");
    const flipped = s.slice(0, 10) + (s[10] === "A" ? "B" : "A") + s.slice(11);
    assert(!(await verifyPlaidWebhook(body, `${h}.${p}.${flipped}`)), "bad signature");
  });
  await check("webhooks find their connection by Plaid's item id", async () => {
    assertEq((await feeds.connectionForItem(itemId))?.id, conn.id, "found");
    assertEq((await feeds.connectionForItem("item-nobody")) ?? null, null, "unknown item");
  });
  await check("new transactions: the webhook syncs; a broken login, an expiring one, and a repair update the status", async () => {
    fake.add(itemId, txn("c5", "acc-checking", 33, "2026-04-03", "Hardware store"));
    const sys = systemActor(t.org.id);
    await runAs(sys, (ctx) => feeds.handleFeedWebhook(ctx, conn.id, { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId }));
    assert(await lineFor("c5"), "synced by the webhook");
    await runAs(sys, (ctx) =>
      feeds.handleFeedWebhook(ctx, conn.id, { webhook_type: "ITEM", webhook_code: "ERROR", item_id: itemId, error: { error_code: "ITEM_LOGIN_REQUIRED", display_message: "Sign in to your bank again." } })
    );
    let [row] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assertEq(row.status, "login_required", "broken");
    assertEq(row.lastError, "Sign in to your bank again.", "Plaid's message");
    await runAs(sys, (ctx) => feeds.handleFeedWebhook(ctx, conn.id, { webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: itemId }));
    [row] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assertEq(row.status, "active", "repaired");
    await runAs(sys, (ctx) => feeds.handleFeedWebhook(ctx, conn.id, { webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: itemId }));
    [row] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assertEq(row.status, "active", "still working");
    assert(row.lastError?.includes("expires soon"), "warned");
    assert((await audits("bank.feed.webhook")) >= 4, "audited");
  });

  section("Daily run and agents");
  await check("the daily run syncs every working feed of the company", async () => {
    fake.add(itemId, txn("c6", "acc-checking", 7.5, "2026-04-04", "Parking"));
    const r = await feeds.runBankFeedsForOrg(t.org.id);
    assertEq(r.checked, 1, "checked");
    assertEq(r.synced, 1, "synced");
    assert(await lineFor("c6"), "line in");
  });
  await check("agents read feeds and update them, but never connect, link, reconnect, or disconnect", async () => {
    const list = await run(agent, (ctx) => feeds.listBankFeeds(ctx));
    assertEq(list.length, 1, "reads");
    fake.add(itemId, txn("c7", "acc-checking", 3, "2026-04-05", "Tolls"));
    const r = await run(agent, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id }));
    assertEq(r.added, 1, "syncs");
    await expectError(() => run(agentAdmin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("0000"), accountId: null })), "forbidden");
    await expectError(() => run(agentAdmin, (ctx) => feeds.disconnectBank(ctx, { id: conn.id })), "forbidden");
    await expectError(() => run(agentAdmin, (ctx) => feeds.markReconnected(ctx, { id: conn.id })), "forbidden");
    const names = OPERATIONS.map((o) => o.name);
    assert(names.includes("list_bank_feeds") && names.includes("sync_bank_feed"), "in the API and MCP");
    assert(!names.some((n) => /connect_bank|link_bank_feed|disconnect_bank/.test(n)), "people-only steps aren't operations");
  });

  section("Another company");
  await check("another company sees none of these feeds and can't touch them", async () => {
    const oa = other.as("owner");
    assertEq((await other.run(oa, (ctx) => feeds.listBankFeeds(ctx))).length, 0, "empty");
    await expectError(() => other.run(oa, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id })), "not_found");
    await expectError(() => other.run(oa, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("0000"), accountId: null })), "not_found");
    await expectError(() => other.run(oa, (ctx) => feeds.disconnectBank(ctx, { id: conn.id })), "not_found");
    await expectError(() => other.run(oa, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("0000"), accountId: account(other, "1010").id })), "not_found");
  });
  await check("the database refuses a feed account that points at another company's account", async () => {
    let refused = false;
    try {
      await db.update(bankFeedAccounts).set({ accountId: account(other, "1010").id }).where(eq(bankFeedAccounts.id, feedAcct("0000")));
    } catch {
      refused = true;
    }
    assert(refused, "tenant guard");
  });

  section("Disconnecting");
  await check("disconnecting forgets the login at Plaid and here; lines already in stay", async () => {
    const before = await feedLines(checking.id);
    await expectError(() => run(bookkeeper, (ctx) => feeds.disconnectBank(ctx, { id: conn.id })), "forbidden");
    const list = await run(admin, (ctx) => feeds.disconnectBank(ctx, { id: conn.id }));
    assertEq(list[0].status, "disconnected", "status");
    const [row] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assertEq(row.accessToken, null, "token gone");
    assertEq(row.cursor, null, "cursor gone");
    assert(fake.state.items.get(itemId)!.removed, "removed at Plaid");
    assertEq(await feedLines(checking.id), before, "lines stay");
    await expectError(() => run(bookkeeper, (ctx) => feeds.syncBankFeed(ctx, { id: conn.id })), "invalid_state");
    await expectError(() => run(admin, (ctx) => feeds.createLinkToken(ctx, { connectionId: conn.id })), "invalid_state");
    await expectError(() => run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: feedAcct("1111"), accountId: savings.id })), "invalid_state");
    assertEq((await feeds.runBankFeedsForOrg(t.org.id)).checked, 0, "the daily run skips it");
    await runAs(systemActor(t.org.id), (ctx) => feeds.handleFeedWebhook(ctx, conn.id, { webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: itemId }));
    const [after] = await db.select().from(bankFeedConnections).where(eq(bankFeedConnections.id, conn.id));
    assertEq(after.status, "disconnected", "webhooks don't revive it");
  });
  await check("a new bank can then feed the same account", async () => {
    const next = fake.signIn({ institution: "Second Bank" });
    const list = await run(admin, (ctx) => feeds.connectBank(ctx, { publicToken: next.publicToken, institutionName: "Second Bank" }));
    const fresh = list.find((c) => c.institutionName === "Second Bank")!;
    const after = await run(admin, (ctx) => feeds.linkFeedAccount(ctx, { id: fresh.accounts.find((a) => a.mask === "0000")!.id, accountId: checking.id }));
    assertEq(after.find((c) => c.id === fresh.id)!.accounts.find((a) => a.mask === "0000")!.accountId, checking.id, "linked");
  });

  section("The page's security policy");
  await check("Plaid's frame and API are allowed on the Bank Feeds page only", async () => {
    const page = contentSecurityPolicy("n0nce", "/banking/feeds");
    assert(page.includes(`frame-src 'self' ${fake.url}`), page);
    assert(/connect-src [^;]*http:\/\/127\.0\.0\.1/.test(page), "connect-src");
    const elsewhere = contentSecurityPolicy("n0nce", "/banking/review");
    assert(!elsewhere.includes("frame-src") && !elsewhere.includes(fake.url), elsewhere);
  });

  await fake.close();
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
