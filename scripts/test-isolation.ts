/**
 * Workspace isolation: workspace A's API key, MCP tools, and people must
 * never read, change, or borrow anything in workspace B. Sweeps every
 * operation in the registry rather than a hand-picked few, so a new
 * endpoint that forgets its tenant filter fails here. Ends by proving B's
 * rows are byte-for-byte what they were before the attacks.
 *
 *   npx tsx scripts/test-isolation.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, dimensions, fiscalPeriods, fiscalYears, memberships, workspaceMembers } from "../src/lib/db/schema";
import { createBudget } from "../src/lib/gl/budgets";
import { runAsWorkspace, workspaceActor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { handleMcp } from "../src/lib/api/mcp";
import { OPERATIONS } from "../src/lib/api/operations";
import { handleRest } from "../src/lib/api/rest";
import * as ws from "../src/lib/workspace/service";
import { account, assert, assertEq, check, createTestOrg, deleteOrgs, finish, section, type TestOrg } from "./lib/harness";

const BASE = "http://test.local";
const MARKER = `ISOLATION-SECRET-${Date.now()}`;

async function rest(token: string, method: string, path: string, body?: unknown) {
  const url = new URL(`/api/v1${path}`, BASE);
  const req = new Request(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleRest(req, url.pathname.replace(/^\/api\/v1\//, "").split("/"));
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await handleMcp(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    })
  );
  const json = await res.json();
  return json.result as { isError?: boolean; content: Array<{ text: string }> };
}

async function ownerKey(t: TestOrg): Promise<string> {
  return t.run(t.as("owner"), async (ctx) =>
    (await agentsSvc.createApiKey(ctx, { name: "isolation", scopes: ["read", "write", "post", "admin"] })).token
  );
}

/** Every company-scoped table, found from the catalog so new tables are covered too. */
async function tenantTables(): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'organization_id'
     ORDER BY 1
  `);
  return rows.map((r) => r.table_name);
}

/** A fingerprint of every row the company owns, table by table. */
async function fingerprint(orgId: string, tables: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tables) {
    const [row] = await db.execute<{ n: number; h: string | null }>(
      sql.raw(
        `SELECT count(*)::int AS n, md5(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text)) AS h FROM public."${t}" x WHERE organization_id = '${orgId}'`
      )
    );
    out[t] = `${row.n}:${row.h ?? ""}`;
  }
  return out;
}

/** Rows of `table` an authenticated user can see through RLS, in one company. */
async function visibleTo(userId: string, table: string, orgId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`);
    await tx.execute(sql.raw("SET LOCAL ROLE authenticated"));
    const [row] = await tx.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM public."${table}" WHERE organization_id = '${orgId}'`)
    );
    return row.n;
  });
}

async function newUser(tag: string): Promise<string> {
  const [row] = await db.execute<{ id: string }>(
    sql`INSERT INTO auth.users (email) VALUES (${`${tag}-${Date.now()}@example.com`}) RETURNING id`
  );
  return row.id;
}

async function main() {
  process.env.EMAIL_TRANSPORT = "memory";
  const a = await createTestOrg("iso-a-");
  const b = await createTestOrg("iso-b-");
  console.log(`\nWorkspace A: ${a.org.slug}\nWorkspace B: ${b.org.slug}`);
  const keyA = await ownerKey(a);
  const keyB = await ownerKey(b);

  // B's books: one of everything, named with a marker A must never see.
  const ids = {} as Record<string, string>;
  let bBudgetId = "";
  {
    const income = account(b, "4100");
    const bank = account(b, "1010");
    const expense = account(b, "6100");
    const ok = async (r: Promise<{ status: number; json: { id: string } }>, label: string) => {
      const res = await r;
      assertEq(res.status, 200, `B setup: ${label} ${JSON.stringify(res.json)}`);
      return res.json.id;
    };
    ids.accounts = await ok(rest(keyB, "POST", "/accounts", { code: "6999", name: `${MARKER} expense`, subcategory: "operating_expense" }), "account");
    ids.customers = await ok(rest(keyB, "POST", "/customers", { name: `${MARKER} customer` }), "customer");
    ids.items = await ok(rest(keyB, "POST", "/items", { name: `${MARKER} item`, salesPrice: "250", incomeAccountId: income.id }), "item");
    ids.vendors = await ok(rest(keyB, "POST", "/vendors", { name: `${MARKER} vendor` }), "vendor");
    ids["stock-items"] = await ok(
      rest(keyB, "POST", "/items", { name: `${MARKER} stock`, type: "inventory", salesPrice: "9", incomeAccountId: income.id, openingStock: { quantity: "3", unitCost: "4", asOf: "2026-05-01" } }),
      "inventory item"
    );
    ids.inventory = (await rest(keyB, "GET", "/inventory/adjustments")).json.data[0].id as string;
    ids.invoices = await ok(
      rest(keyB, "POST", "/invoices", { customerId: ids.customers, invoiceDate: "2026-05-01", lines: [{ itemId: ids.items, quantity: 4 }], post: true }),
      "invoice"
    );
    ids["customer-payments"] = await ok(
      rest(keyB, "POST", "/customer-payments", { customerId: ids.customers, paymentDate: "2026-05-02", method: "check", depositAccountId: bank.id, applications: [{ invoiceId: ids.invoices, amount: "100" }] }),
      "customer payment"
    );
    ids.bills = await ok(
      rest(keyB, "POST", "/bills", { vendorId: ids.vendors, billDate: "2026-05-01", lines: [{ accountId: expense.id, amount: "300", description: MARKER }] }),
      "bill"
    );
    ids["journal-entries"] = await ok(
      rest(keyB, "POST", "/journal-entries", {
        date: "2026-05-03",
        description: `${MARKER} entry`,
        lines: [{ accountId: expense.id, debit: "50" }, { accountId: bank.id, credit: "50" }],
        post: true,
      }),
      "journal entry"
    );
    // A bill payment needs a posted bill: create, submit, approve, post.
    const billToPay = await ok(
      rest(keyB, "POST", "/bills", { vendorId: ids.vendors, billDate: "2026-05-01", lines: [{ accountId: expense.id, amount: "80" }] }),
      "bill to pay"
    );
    await ok(rest(keyB, "POST", `/bills/${billToPay}/submit`), "submit bill");
    await ok(rest(keyB, "POST", `/bills/${billToPay}/approve`), "approve bill");
    await ok(rest(keyB, "POST", `/bills/${billToPay}/post`), "post bill");
    ids["bill-payments"] = await ok(
      rest(keyB, "POST", "/bill-payments", { vendorId: ids.vendors, paymentDate: "2026-05-04", method: "ach", bankAccountId: bank.id, applications: [{ billId: billToPay, amount: "80" }] }),
      "bill payment"
    );
    // Vendor credits: one applied to a posted bill, its remainder refunded.
    const billForCredit = await ok(
      rest(keyB, "POST", "/bills", { vendorId: ids.vendors, billDate: "2026-05-01", lines: [{ accountId: expense.id, amount: "40" }] }),
      "bill for credit"
    );
    for (const step of ["submit", "approve", "post"]) await ok(rest(keyB, "POST", `/bills/${billForCredit}/${step}`), `${step} bill for credit`);
    ids["vendor-credits"] = await ok(
      rest(keyB, "POST", "/vendor-credits", { vendorId: ids.vendors, creditDate: "2026-05-02", vendorReference: MARKER, lines: [{ accountId: expense.id, amount: "30" }], post: true }),
      "vendor credit"
    );
    ids["vendor-credit-applications"] = await ok(
      rest(keyB, "POST", "/vendor-credit-applications", { vendorCreditId: ids["vendor-credits"], billId: billForCredit, amount: "20" }),
      "vendor credit application"
    );
    ids["vendor-refunds"] = await ok(
      rest(keyB, "POST", "/vendor-refunds", { vendorId: ids.vendors, refundDate: "2026-05-03", method: "check", bankAccountId: bank.id, amount: "10", memo: MARKER, post: true }),
      "vendor refund"
    );
    // An approved purchase order, partly billed.
    ids["purchase-orders"] = await ok(
      rest(keyB, "POST", "/purchase-orders", { vendorId: ids.vendors, poDate: "2026-05-01", vendorMessage: MARKER, lines: [{ accountId: expense.id, description: MARKER, unitCost: "60" }], submit: true }),
      "purchase order"
    );
    const bPo = await rest(keyB, "GET", `/purchase-orders/${ids["purchase-orders"]}`);
    assertEq(bPo.json.status, "open", "B setup: the owner's PO is approved on submit");
    await ok(rest(keyB, "POST", `/purchase-orders/${ids["purchase-orders"]}/bill`, { billDate: "2026-05-02", mode: "percent", percent: "50" }), "bill from PO");
    // A recurring bill, and a 1099 vendor paid on a 1099 account.
    ids["recurring-bills"] = await ok(
      rest(keyB, "POST", "/recurring-bills", { name: `${MARKER} rent`, vendorId: ids.vendors, type: "unscheduled", lines: [{ accountId: expense.id, amount: "10", description: MARKER }] }),
      "recurring bill"
    );
    const contractor = await ok(rest(keyB, "POST", "/vendors", { name: `${MARKER} contractor`, is1099Vendor: true, tin: "99-1234567" }), "1099 vendor");
    await ok(
      rest(keyB, "POST", "/expenses", { txnDate: "2026-05-05", bankAccountId: bank.id, vendorId: contractor, lines: [{ accountId: account(b, "6150").id, amount: "2500" }], post: true }),
      "1099 payment"
    );
    // A budget, for the report checks.
    const [bYear] = await db.select().from(fiscalYears).where(eq(fiscalYears.organizationId, b.org.id));
    bBudgetId = (await createBudget({ organizationId: b.org.id, fiscalYearId: bYear.id, code: "ISO", name: `${MARKER} budget` })).id;
    // A check waiting in B's print queue.
    ids.checks = await ok(
      rest(keyB, "POST", "/expenses", { type: "check", printLater: true, txnDate: "2026-05-05", bankAccountId: bank.id, payeeName: `${MARKER} check`, lines: [{ accountId: expense.id, amount: "15" }], post: true }),
      "queued check"
    );
    // Banking: a posted expense, a rule, an imported line, a reconciliation in progress.
    ids["bank-transactions"] = await ok(
      rest(keyB, "POST", "/expenses", { txnDate: "2026-05-05", bankAccountId: bank.id, payeeName: `${MARKER} payee`, lines: [{ accountId: expense.id, amount: "25", description: MARKER }], post: true }),
      "expense"
    );
    ids["bank-rules"] = await ok(
      rest(keyB, "POST", "/bank-rules", { name: `${MARKER} rule`, conditions: [{ field: "description", op: "contains", value: "zzz" }], categoryAccountId: expense.id }),
      "bank rule"
    );
    const imported = await rest(keyB, "POST", "/bank-statements", { accountId: bank.id, content: `Date,Description,Amount\n05/06/2026,${MARKER} line,-12.00\n`, applyRules: false });
    assertEq(imported.status, 200, `B setup: statement import ${imported.text.slice(0, 160)}`);
    ids["bank-lines"] = (await rest(keyB, "GET", `/bank-lines?accountId=${bank.id}`)).json.data[0].id;
    ids.reconciliations = await ok(
      rest(keyB, "POST", "/reconciliations", { accountId: bank.id, statementEndDate: "2026-05-31", statementEndingBalance: "0" }),
      "reconciliation"
    );
    // Sales tax and the other sales documents.
    ids["tax-agencies"] = await ok(rest(keyB, "POST", "/tax-agencies", { name: `${MARKER} agency` }), "tax agency");
    ids["tax-rates"] = await ok(
      rest(keyB, "POST", "/tax-rates", { name: `${MARKER} rate`, agencyId: ids["tax-agencies"], ratePercent: "5" }),
      "tax rate"
    );
    ids["sales-receipts"] = await ok(
      rest(keyB, "POST", "/sales-receipts", { customerId: ids.customers, receiptDate: "2026-05-06", method: "cash", taxCodeId: ids["tax-rates"], lines: [{ itemId: ids.items }], post: true }),
      "sales receipt"
    );
    ids["credit-memos"] = await ok(
      rest(keyB, "POST", "/credit-memos", { customerId: ids.customers, memoDate: "2026-05-07", lines: [{ itemId: ids.items, quantity: 1, unitPrice: "20" }], post: true }),
      "credit memo"
    );
    const memo = await rest(keyB, "GET", `/credit-memos/${ids["credit-memos"]}`);
    ids["credit-applications"] = memo.json.uses[0]?.id;
    assert(ids["credit-applications"], "B setup: the credit memo auto-applied to B's open invoice");
    ids.refunds = await ok(
      rest(keyB, "POST", "/refunds", { kind: "items", customerId: ids.customers, refundDate: "2026-05-08", method: "check", bankAccountId: bank.id, lines: [{ itemId: ids.items, unitPrice: "10" }], post: true }),
      "refund"
    );
    ids["tax-payments"] = await ok(
      rest(keyB, "POST", "/tax-payments", { agencyId: ids["tax-agencies"], paymentDate: "2026-05-31", periodEnd: "2026-05-31", amount: "1", bankAccountId: bank.id }),
      "tax payment"
    );
    // Estimates and recurring invoices.
    ids.estimates = await ok(
      rest(keyB, "POST", "/estimates", { customerId: ids.customers, estimateDate: "2026-05-09", memo: MARKER, lines: [{ itemId: ids.items, quantity: 2, unitPrice: "30" }] }),
      "estimate"
    );
    // An emailed invoice: A must never see the send or its subject.
    await ok(rest(keyB, "POST", "/emails", { documentType: "invoice", documentId: ids.invoices, to: ["billing@b.test"] }), "emailed invoice");
    // Month-end close: a checklist item, and a period A must not close or read.
    ids["close-tasks"] = await ok(rest(keyB, "POST", "/close-tasks", { title: `${MARKER} close step` }), "close task");
    const [bPeriod] = await db.select().from(fiscalPeriods).where(eq(fiscalPeriods.organizationId, b.org.id)).orderBy(fiscalPeriods.startDate).limit(1);
    ids.periods = bPeriod.id;
    // B's letterhead: A must never see it, on screen or in a PDF.
    await ok(rest(keyB, "PATCH", "/company-profile", { legalName: `${MARKER} letterhead`, documentFooter: MARKER }), "company profile");
    ids["recurring-invoices"] = await ok(
      rest(keyB, "POST", "/recurring-invoices", { name: `${MARKER} template`, customerId: ids.customers, type: "unscheduled", lines: [{ itemId: ids.items }] }),
      "recurring invoice"
    );
  }
  const bEstimateLine = (await rest(keyB, "GET", `/estimates/${ids.estimates}`)).json.lines[0].id as string;
  const bPoLine = (await rest(keyB, "GET", `/purchase-orders/${ids["purchase-orders"]}`)).json.lines[0].id as string;
  const secrets = [MARKER, b.org.id, ...Object.values(ids)];
  const tables = await tenantTables();
  const before = await fingerprint(b.org.id, tables);

  section("Every operation that takes an id refuses the other workspace's records");
  const byId = OPERATIONS.filter((op) => op.path.includes("{id}"));
  // Full-replace updates need a valid body; built from A's own records so
  // the only thing wrong is the id.
  const aCustomer = (await rest(keyA, "POST", "/customers", { name: "A's own customer" })).json.id as string;
  const aVendor = (await rest(keyA, "POST", "/vendors", { name: "A's own vendor" })).json.id as string;
  const aIncome = account(a, "4100").id;
  const aBank = account(a, "1010").id;
  const aExpense = account(a, "6100").id;
  const bodies: Record<string, Record<string, unknown>> = {
    update_invoice: { customerId: aCustomer, invoiceDate: "2026-05-01", lines: [{ description: "x", quantity: 1, unitPrice: "10", accountId: aIncome }] },
    update_bill: { vendorId: aVendor, billDate: "2026-05-01", lines: [{ accountId: aExpense, amount: "1" }] },
    update_estimate: { customerId: aCustomer, estimateDate: "2026-05-01", lines: [{ description: "x", quantity: 1, unitPrice: "10", accountId: aIncome }] },
    set_estimate_status: { status: "accepted" },
    create_invoice_from_estimate: { invoiceDate: "2026-05-01" },
    update_recurring_invoice: { name: "x", customerId: aCustomer, type: "unscheduled", lines: [{ description: "x", quantity: 1, unitPrice: "10", accountId: aIncome }] },
    set_recurring_invoice_status: { status: "paused" },
    update_purchase_order: { vendorId: aVendor, poDate: "2026-05-01", lines: [{ accountId: aExpense, unitCost: "1" }] },
    create_bill_from_purchase_order: { billDate: "2026-05-05" },
    update_recurring_bill: { name: "x", vendorId: aVendor, type: "unscheduled", lines: [{ accountId: aExpense, amount: "1" }] },
    set_recurring_bill_status: { status: "paused" },
    set_account_1099_box: { box: "nec_1" },
    match_bank_line: { glLineIds: [crypto.randomUUID()] },
    set_reconciliation_cleared: { glLineIds: [crypto.randomUUID()], cleared: true },
    close_period: { note: "isolation test" },
    set_close_task: { taskId: crypto.randomUUID() },
  };
  const bodyFor = (name: string) => ({ reason: "isolation test", date: "2026-05-05", ...bodies[name] });
  const aItem = (await rest(keyA, "POST", "/items", { name: "A's own item", salesPrice: "5", incomeAccountId: aIncome })).json.id as string;
  const aInvoice = (await rest(keyA, "POST", "/invoices", bodies.update_invoice)).json.id as string;
  const aStock = (await rest(keyA, "POST", "/items", { name: "A's own stock", type: "inventory", salesPrice: "5", incomeAccountId: aIncome })).json.id as string;
  await check(`REST: all ${byId.length} by-id operations answer 404 for B's ids`, async () => {
    const misses: string[] = [];
    for (const op of byId) {
      const resource = op.path.split("/")[1];
      const target = ids[resource];
      assert(target, `no B fixture for /${resource} (add one when adding a resource)`);
      const body = op.method === "GET" || op.method === "DELETE" ? undefined : bodyFor(op.name);
      const r = await rest(keyA, op.method, op.path.replace("{id}", target), body);
      const leaked = secrets.some((s) => s !== target && r.text.includes(s)) || r.text.includes(MARKER);
      if (r.status !== 404 || leaked) misses.push(`${op.name} → ${r.status}${leaked ? " (leaked data)" : ""}`);
    }
    assert(misses.length === 0, misses.join("; "));
  });

  await check(`MCP: the same ${byId.length} tools answer not_found`, async () => {
    const misses: string[] = [];
    for (const op of byId) {
      const target = ids[op.path.split("/")[1]];
      const r = await tool(keyA, op.name, { ...bodyFor(op.name), id: target });
      const text = r.content.map((c) => c.text).join("\n");
      if (!r.isError || !text.includes("not_found") || text.includes(MARKER)) misses.push(`${op.name}: ${text.slice(0, 80)}`);
    }
    assert(misses.length === 0, misses.join("; "));
  });

  section("Lists, reports, and context never show the other workspace");
  const reads = OPERATIONS.filter((op) => op.method === "GET" && !op.path.includes("{id}"));
  await check(`REST: ${reads.length} list and report endpoints carry nothing of B's`, async () => {
    const query = `?from=2026-01-01&to=2026-12-31&asOf=2026-12-31&accountId=${account(a, "1010").id}&includeInactive=true&limit=200`;
    const misses: string[] = [];
    for (const op of reads) {
      const r = await rest(keyA, "GET", op.path + query);
      if (r.status !== 200) misses.push(`${op.name} → ${r.status} ${r.text.slice(0, 120)}`);
      else if (secrets.some((s) => r.text.includes(s))) misses.push(`${op.name} leaked B's data`);
    }
    assert(misses.length === 0, misses.join("; "));
  });

  await check("filters can't reach across: listing by B's customer or account finds nothing", async () => {
    const inv = await rest(keyA, "GET", `/invoices?customerId=${ids.customers}`);
    assert(inv.status === 200 || inv.status === 404, `invoices status ${inv.status}`);
    assert(!secrets.some((s) => inv.text.includes(s)) || inv.status === 404, "invoices leaked");
    const ledger = await rest(keyA, "GET", `/reports/account-ledger?accountId=${ids.accounts}&from=2026-01-01&to=2026-12-31`);
    assert(ledger.status === 404 || !ledger.text.includes(MARKER), `ledger ${ledger.status} ${ledger.text.slice(0, 120)}`);
  });

  await check("reports refuse B's dimension, budget, and account", async () => {
    const [bClass] = await db.select().from(dimensions).where(and(eq(dimensions.organizationId, b.org.id), eq(dimensions.code, "CLASS")));
    for (const path of [
      `/reports/profit-and-loss-by-class?dimensionId=${bClass.id}`,
      `/reports/budget-vs-actual?budgetId=${bBudgetId}`,
      `/reports/export?report=account-ledger&accountId=${ids.accounts}`,
      `/reports/export?report=budget-vs-actual&budgetId=${bBudgetId}&format=pdf`,
    ]) {
      const r = await rest(keyA, "GET", path);
      assertEq(r.status, 404, path);
      assert(!r.text.includes(MARKER), `${path} leaked`);
    }
  });

  section("Creates can't borrow the other workspace's records");
  const bBank = account(b, "1010").id;
  // A's own posted bill and vendor credit, so the only foreign id is B's.
  const aBill = (await rest(keyA, "POST", "/bills", { vendorId: aVendor, billDate: "2026-05-01", lines: [{ accountId: aExpense, amount: "5" }] })).json.id as string;
  for (const step of ["submit", "approve", "post"]) await rest(keyA, "POST", `/bills/${aBill}/${step}`);
  const aCredit = (await rest(keyA, "POST", "/vendor-credits", { vendorId: aVendor, creditDate: "2026-05-02", lines: [{ accountId: aExpense, amount: "1" }], post: true })).json.id as string;
  const [aPeriod] = await db.select().from(fiscalPeriods).where(eq(fiscalPeriods.organizationId, a.org.id)).orderBy(fiscalPeriods.startDate).limit(1);
  const borrow: Array<[string, string, unknown]> = [
    ["sign-off with B's checklist item", `/periods/${aPeriod.id}/tasks`, { taskId: ids["close-tasks"] }],
    ["email B's invoice", "/emails", { documentType: "invoice", documentId: ids.invoices, to: ["x@y.test"] }],
    ["email B's statement", "/emails", { documentType: "statement", documentId: ids.customers, to: ["x@y.test"] }],
    ["email B's purchase order", "/emails", { documentType: "purchase_order", documentId: ids["purchase-orders"], to: ["x@y.test"] }],
    ["invoice for B's customer", "/invoices", { customerId: ids.customers, invoiceDate: "2026-05-01", lines: [{ description: "x", quantity: 1, unitPrice: "10", accountId: aIncome }] }],
    ["invoice line on B's item", "/invoices", { customerId: aCustomer, invoiceDate: "2026-05-01", lines: [{ itemId: ids.items, quantity: 1 }] }],
    ["invoice line on B's account", "/invoices", { customerId: aCustomer, invoiceDate: "2026-05-01", lines: [{ description: "x", quantity: 1, unitPrice: "10", accountId: ids.accounts }] }],
    ["payment applied to B's invoice", "/customer-payments", { customerId: aCustomer, paymentDate: "2026-05-02", method: "check", depositAccountId: aBank, applications: [{ invoiceId: ids.invoices, amount: "1" }] }],
    ["bill for B's vendor", "/bills", { vendorId: ids.vendors, billDate: "2026-05-01", lines: [{ accountId: aExpense, amount: "1" }] }],
    ["bill line on B's account", "/bills", { vendorId: aVendor, billDate: "2026-05-01", lines: [{ accountId: ids.accounts, amount: "1" }] }],
    ["bill payment for B's bill", "/bill-payments", { vendorId: aVendor, paymentDate: "2026-05-04", method: "ach", bankAccountId: aBank, applications: [{ billId: ids.bills, amount: "1" }] }],
    ["bill payment from B's bank account", "/bill-payments", { vendorId: aVendor, paymentDate: "2026-05-04", method: "ach", bankAccountId: ids.accounts, applications: [{ billId: ids.bills, amount: "1" }] }],
    ["journal entry on B's accounts", "/journal-entries", { date: "2026-05-03", description: "x", lines: [{ accountId: ids.accounts, debit: "1" }, { accountId: aBank, credit: "1" }] }],
    ["journal line tagged with B's customer", "/journal-entries", { date: "2026-05-03", description: "x", lines: [{ accountId: aExpense, debit: "1", customerId: ids.customers }, { accountId: aBank, credit: "1" }] }],
    ["expense from B's bank account", "/expenses", { txnDate: "2026-05-05", bankAccountId: bBank, lines: [{ accountId: aExpense, amount: "1" }] }],
    ["expense line on B's account", "/expenses", { txnDate: "2026-05-05", bankAccountId: aBank, lines: [{ accountId: ids.accounts, amount: "1" }] }],
    ["deposit of B's customer payment", "/deposits", { txnDate: "2026-05-05", bankAccountId: aBank, paymentIds: [ids["customer-payments"]] }],
    ["transfer into B's bank account", "/transfers", { txnDate: "2026-05-05", fromAccountId: aBank, toAccountId: bBank, amount: "1" }],
    ["statement import into B's account", "/bank-statements", { accountId: bBank, content: "Date,Description,Amount\n05/06/2026,x,-1.00\n" }],
    ["bank rule categorizing to B's account", "/bank-rules", { name: "x", conditions: [{ field: "description", op: "contains", value: "x" }], categoryAccountId: ids.accounts }],
    ["reconciliation of B's account", "/reconciliations", { accountId: bBank, statementEndDate: "2026-05-31", statementEndingBalance: "0" }],
    ["sales receipt for B's customer", "/sales-receipts", { customerId: ids.customers, receiptDate: "2026-05-06", method: "cash", lines: [{ itemId: aItem }] }],
    ["sales receipt taxed at B's rate", "/sales-receipts", { receiptDate: "2026-05-06", method: "cash", taxCodeId: ids["tax-rates"], lines: [{ itemId: aItem }] }],
    ["credit memo for B's customer", "/credit-memos", { customerId: ids.customers, memoDate: "2026-05-07", lines: [{ itemId: aItem }] }],
    ["refund from B's bank account", "/refunds", { kind: "items", customerId: aCustomer, refundDate: "2026-05-08", method: "check", bankAccountId: bBank, lines: [{ itemId: aItem }] }],
    ["B's credit applied to A's invoice", "/credit-applications", { creditMemoId: ids["credit-memos"], invoiceId: aInvoice }],
    ["tax payment to B's agency", "/tax-payments", { agencyId: ids["tax-agencies"], paymentDate: "2026-05-31", periodEnd: "2026-05-31", amount: "1", bankAccountId: aBank }],
    ["tax rate under B's agency", "/tax-rates", { name: "x", agencyId: ids["tax-agencies"], ratePercent: "1" }],
    ["customer defaulting to B's tax rate", "/customers", { name: "x", defaultTaxCodeId: ids["tax-rates"] }],
    ["estimate for B's customer", "/estimates", { customerId: ids.customers, estimateDate: "2026-05-09", lines: [{ itemId: aItem }] }],
    ["estimate taxed at B's rate", "/estimates", { customerId: aCustomer, estimateDate: "2026-05-09", taxCodeId: ids["tax-rates"], lines: [{ itemId: aItem }] }],
    ["invoice line billing B's estimate", "/invoices", { customerId: aCustomer, invoiceDate: "2026-05-01", lines: [{ itemId: aItem, estimateLineId: bEstimateLine }] }],
    ["recurring invoice for B's customer", "/recurring-invoices", { name: "x", customerId: ids.customers, type: "unscheduled", lines: [{ itemId: aItem }] }],
    ["recurring invoice with B's item", "/recurring-invoices", { name: "y", customerId: aCustomer, type: "unscheduled", lines: [{ itemId: ids.items }] }],
    ["vendor credit for B's vendor", "/vendor-credits", { vendorId: ids.vendors, creditDate: "2026-05-02", lines: [{ accountId: aExpense, amount: "1" }] }],
    ["vendor credit line on B's account", "/vendor-credits", { vendorId: aVendor, creditDate: "2026-05-02", lines: [{ accountId: ids.accounts, amount: "1" }] }],
    ["B's vendor credit applied to A's bill", "/vendor-credit-applications", { vendorCreditId: ids["vendor-credits"], billId: aBill }],
    ["A's vendor credit applied to B's bill", "/vendor-credit-applications", { vendorCreditId: aCredit, billId: ids.bills }],
    ["vendor refund into B's bank account", "/vendor-refunds", { vendorId: aVendor, refundDate: "2026-05-03", method: "check", bankAccountId: bBank, amount: "1" }],
    ["vendor refund of B's vendor credit", "/vendor-refunds", { vendorId: aVendor, refundDate: "2026-05-03", method: "check", bankAccountId: aBank, amount: "1", vendorCreditId: ids["vendor-credits"] }],
    ["recurring bill for B's vendor", "/recurring-bills", { name: "x", vendorId: ids.vendors, type: "unscheduled", lines: [{ accountId: aExpense, amount: "1" }] }],
    ["recurring bill line on B's account", "/recurring-bills", { name: "y", vendorId: aVendor, type: "unscheduled", lines: [{ accountId: ids.accounts, amount: "1" }] }],
    ["purchase order for B's vendor", "/purchase-orders", { vendorId: ids.vendors, poDate: "2026-05-01", lines: [{ accountId: aExpense, unitCost: "1" }] }],
    ["purchase order line on B's account", "/purchase-orders", { vendorId: aVendor, poDate: "2026-05-01", lines: [{ accountId: ids.accounts, unitCost: "1" }] }],
    ["purchase order line with B's item", "/purchase-orders", { vendorId: aVendor, poDate: "2026-05-01", lines: [{ itemId: ids.items, accountId: aExpense, unitCost: "1" }] }],
    ["bill line billing B's purchase order line", "/bills", { vendorId: aVendor, billDate: "2026-05-01", lines: [{ accountId: aExpense, amount: "1", purchaseOrderLineId: bPoLine }] }],
    ["printing B's queued check", "/checks/print", { bankAccountId: aBank, firstCheckNumber: 1, checks: [{ kind: "check", id: ids.checks }] }],
    ["adjusting B's inventory item", "/inventory/adjustments", { adjustmentDate: "2026-05-05", offsetAccountId: account(a, "5900").id, lines: [{ itemId: ids["stock-items"], quantity: "1", unitCost: "1" }] }],
    ["adjustment against B's account", "/inventory/adjustments", { adjustmentDate: "2026-05-05", offsetAccountId: ids.accounts, lines: [{ itemId: aStock, quantity: "1", unitCost: "1" }] }],
    ["bill buying B's inventory item", "/bills", { vendorId: aVendor, billDate: "2026-05-01", lines: [{ itemId: ids["stock-items"], quantity: "1", unitCost: "1" }] }],
    ["check buying B's inventory item", "/expenses", { type: "check", txnDate: "2026-05-05", bankAccountId: aBank, lines: [{ itemId: ids["stock-items"], quantity: "1", unitCost: "1" }] }],
    ["inventory item in B's asset account", "/items", { name: "z", type: "inventory", incomeAccountId: aIncome, assetAccountId: account(b, "1300").id }],
    ["printing on B's bank account", "/checks/print", { bankAccountId: bBank, firstCheckNumber: 1, checks: [{ kind: "check", id: ids.checks }] }],
  ];
  for (const [label, path, body] of borrow) {
    await check(`refused: ${label}`, async () => {
      const r = await rest(keyA, "POST", path, body);
      assert(r.status >= 400 && r.status < 500, `expected a 4xx, got ${r.status} ${r.text.slice(0, 160)}`);
      assert(!r.text.includes(MARKER), "error message leaked B's data");
    });
  }

  section("The database itself keeps workspaces apart (RLS)");
  const onlyA = await newUser("iso-a-member");
  await db.insert(workspaceMembers).values({ workspaceId: a.org.workspaceId, userId: onlyA, role: "member" });
  await db.insert(memberships).values({ organizationId: a.org.id, userId: onlyA, role: "accountant" });
  await check(`a member of A sees 0 of B's rows in all ${tables.length} company tables`, async () => {
    const seen: string[] = [];
    for (const t of tables) {
      const n = await visibleTo(onlyA, t, b.org.id);
      if (n > 0) seen.push(`${t} (${n})`);
    }
    assert(seen.length === 0, `visible: ${seen.join(", ")}`);
  });
  await check("…while still seeing A's own books (the walls aren't just closed doors)", async () => {
    assert((await visibleTo(onlyA, "accounts", a.org.id)) > 0, "A's member sees A's accounts");
  });

  await check("every reference between company tables has a tenant guard", async () => {
    const rows = await db.execute<{ ref: string }>(sql`
      SELECT src.relname || '.' || a.attname AS ref
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        JOIN pg_attribute o ON o.attrelid = c.confrelid AND o.attname = 'organization_id' AND NOT o.attisdropped
        JOIN pg_attribute so ON so.attrelid = c.conrelid AND so.attname = 'organization_id' AND NOT so.attisdropped
       WHERE c.contype = 'f' AND src.relnamespace = 'public'::regnamespace
         AND array_length(c.conkey, 1) = 1 AND a.attname <> 'organization_id'
         AND NOT EXISTS (
           SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE t.tgrelid = c.conrelid AND t.tgname = 'tenant_guard'
              AND p.prosrc LIKE '%NEW.' || a.attname || ' IS NOT NULL%')
    `);
    assert(rows.length === 0, `unguarded (run install_tenant_guard): ${rows.map((r) => r.ref).join(", ")}`);
  });
  await check("raw SQL can't point A's rows at B's, or move a row to B", async () => {
    const attempts: Array<[string, ReturnType<typeof sql>]> = [
      ["a line on A's invoice using B's account", sql`UPDATE ar_invoice_lines SET account_id = ${ids.accounts} WHERE invoice_id = ${aInvoice}`],
      ["A's item on B's income account", sql`UPDATE items SET income_account_id = ${ids.accounts} WHERE id = ${aItem}`],
      ["A's inventory item in B's asset account", sql`UPDATE items SET asset_account_id = ${account(b, "1300").id} WHERE id = ${aStock}`],
      ["A's invoice billed to B's customer", sql`UPDATE ar_invoices SET customer_id = ${ids.customers} WHERE id = ${aInvoice}`],
      ["moving B's customer into A", sql`UPDATE customers SET organization_id = ${a.org.id} WHERE id = ${ids.customers}`],
    ];
    for (const [label, q] of attempts) {
      let refused = false;
      try {
        await db.transaction(async (tx) => {
          const res = await tx.execute(q);
          assert(res.count > 0, `${label}: the statement touched no rows, so it proves nothing`);
        });
      } catch (e) {
        const err = e as { code?: string; cause?: { code?: string; message?: string }; message?: string };
        refused = (err.code ?? err.cause?.code) === "23503" && /tenant_guard/.test(err.cause?.message ?? err.message ?? "");
      }
      assert(refused, `${label}: not refused by the tenant guard`);
    }
  });

  section("Workspace-level views stay in their workspace");
  await check("A's workspace audit log has none of B's events", async () => {
    const rows = await runAsWorkspace(
      workspaceActor({ workspaceId: a.org.workspaceId, userId: a.owner.id, role: "owner" }),
      (ctx) => ws.listWorkspaceAudit(ctx, { limit: 200 })
    );
    assert(!JSON.stringify(rows).includes(b.org.id) && !JSON.stringify(rows).includes(MARKER), "B's events leaked");
  });
  await check("A's company list doesn't include B", async () => {
    const actor = workspaceActor({ workspaceId: a.org.workspaceId, userId: a.owner.id, role: "owner" });
    const companies = await runAsWorkspace(actor, (ctx) => ws.listCompanies(ctx));
    assertEq(companies.length, 1, "one company");
    assertEq(companies[0].id, a.org.id, "A's own company");
  });

  section("After all of that");
  await check("B's books are byte-for-byte unchanged", async () => {
    const after = await fingerprint(b.org.id, tables);
    const changed = tables.filter((t) => before[t] !== after[t]);
    assert(changed.length === 0, `changed: ${changed.join(", ")}`);
  });
  await check("no audit row in B came from A's key", async () => {
    const rows = await db.select({ e: auditLog.event }).from(auditLog).where(eq(auditLog.organizationId, b.org.id));
    assert(rows.length > 0, "B has its own audit rows");
    const fromA = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log al JOIN api_keys k ON k.id = al.api_key_id WHERE al.organization_id = ${b.org.id} AND k.organization_id = ${a.org.id}`
    );
    assertEq(fromA[0].n, 0, "rows from A's key");
  });

  await deleteOrgs("iso-a-");
  await deleteOrgs("iso-b-");
  await db.execute(sql`DELETE FROM auth.users WHERE id = ${onlyA}`);
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
