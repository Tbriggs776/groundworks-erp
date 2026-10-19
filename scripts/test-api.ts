/**
 * End-to-end: the REST API and MCP server, driven through their real
 * request handlers with real API keys — auth, scopes, dry runs,
 * idempotency, error envelopes, tool filtering, and agent posting limits.
 *
 *   npx tsx scripts/test-api.ts
 */
import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { arInvoices, auditLog } from "../src/lib/db/schema";
import * as agentsSvc from "../src/lib/agents/service";
import { handleMcp } from "../src/lib/api/mcp";
import { handleRest } from "../src/lib/api/rest";
import { money } from "../src/lib/money";
import {
  account,
  assert,
  assertEq,
  check,
  createTestOrg,
  deleteOrgs,
  finish,
  section,
} from "./lib/harness";

const BASE = "http://test.local";

async function rest(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const url = new URL(`/api/v1${path}`, BASE);
  const req = new Request(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleRest(req, url.pathname.replace(/^\/api\/v1\//, "").split("/"));
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

let rpcId = 0;
async function mcp(token: string, method: string, params?: unknown) {
  const req = new Request(`${BASE}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const res = await handleMcp(req);
  return { status: res.status, json: res.status === 202 ? null : await res.json() };
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  return r.json.result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
  };
}

async function main() {
  const t = await createTestOrg("api-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const services = account(t, "4100");

  const keys = await t.run(t.as("owner"), async (ctx) => {
    const owner = await agentsSvc.createApiKey(ctx, { name: "owner", scopes: ["read", "write", "post", "admin"] });
    const drafter = await agentsSvc.createAgent(ctx, { name: "Drafter", autonomy: "draft" });
    const poster = await agentsSvc.createAgent(ctx, {
      name: "Poster",
      autonomy: "post",
      maxPostAmount: "1000",
    });
    const reader = await agentsSvc.createAgent(ctx, { name: "Reader", role: "viewer", autonomy: "read" });
    return {
      owner: owner.token,
      drafter: (await agentsSvc.createApiKey(ctx, { name: "k", agentId: drafter.id })).token,
      poster: (await agentsSvc.createApiKey(ctx, { name: "k", agentId: poster.id })).token,
      posterAgentId: poster.id,
      reader: (await agentsSvc.createApiKey(ctx, { name: "k", agentId: reader.id })).token,
    };
  });

  section("REST basics");
  await check("no key → 401 with WWW-Authenticate", async () => {
    const r = await rest(null, "GET", "/me");
    assertEq(r.status, 401, "status");
    assertEq(r.json.error.code, "unauthenticated", "code");
    assert(r.headers.get("www-authenticate"), "header");
  });

  await check("GET /me describes the caller", async () => {
    const r = await rest(keys.drafter, "GET", "/me");
    assertEq(r.status, 200, "status");
    assertEq(r.json.actor.kind, "agent", "kind");
    assertEq(r.json.actor.scopes.join(","), "read,write", "scopes");
    assert(r.json.guidance.some((g: string) => g.startsWith("Draft mode")), "guidance");
    assert(r.headers.get("x-request-id"), "request id");
  });

  await check("openapi.json is public and lists every path", async () => {
    const r = await rest(null, "GET", "/openapi.json");
    assertEq(r.status, 200, "status");
    assert(r.json.paths["/invoices/{id}/post"]?.post?.operationId === "post_invoice", "post_invoice");
    assert(Object.keys(r.json.paths).length > 30, "path count");
  });

  await check("unknown route 404, wrong method 405, bad JSON 400", async () => {
    assertEq((await rest(keys.owner, "GET", "/nope")).status, 404, "404");
    const r405 = await rest(keys.owner, "PATCH", "/invoices");
    assertEq(r405.status, 405, "405");
    assert(r405.headers.get("allow")?.includes("POST"), "allow header");
    assertEq((await rest(keys.owner, "POST", "/customers", "{nope")).status, 400, "400");
  });

  await check("query flags: includeInactive=false really means false", async () => {
    await rest(keys.owner, "POST", "/customers", { name: "Dormant LLC", isActive: false });
    const off = await rest(keys.owner, "GET", "/customers?includeInactive=false");
    const on = await rest(keys.owner, "GET", "/customers?includeInactive=true");
    assertEq(off.json.data.length, 0, "excluded");
    assertEq(on.json.data.length, 1, "included");
  });

  section("Writing through REST");
  let customerId = "";
  let itemId = "";
  await check("create customer + item", async () => {
    const c = await rest(keys.owner, "POST", "/customers", { name: "Northwind Traders", email: "ap@northwind.test" });
    assertEq(c.status, 200, "customer status");
    customerId = c.json.id;
    const i = await rest(keys.owner, "POST", "/items", { name: "Bookkeeping", salesPrice: "400", incomeAccountId: services.id });
    assertEq(i.status, 200, "item status");
    itemId = i.json.id;
  });

  await check("PATCH changes only the fields sent", async () => {
    const r = await rest(keys.owner, "PATCH", `/customers/${customerId}`, { phone: "555-0100" });
    assertEq(r.json.phone, "555-0100", "phone");
    assertEq(r.json.email, "ap@northwind.test", "email untouched");
  });

  await check("dry run returns the would-be invoice and saves nothing", async () => {
    const r = await rest(
      keys.owner,
      "POST",
      "/invoices",
      { customerId, invoiceDate: "2026-05-01", lines: [{ itemId, quantity: 3 }], post: true },
      { "x-dry-run": "true" }
    );
    assertEq(r.status, 200, "status");
    assertEq(r.json.dryRun, true, "dryRun flag");
    assertEq(r.json.result.status, "open", "would post");
    assertEq(money(r.json.result.totalAmount).toFixed(2), "1200.00", "total");
    const rows = await db.select().from(arInvoices).where(eq(arInvoices.organizationId, t.org.id));
    assertEq(rows.length, 0, "nothing saved");
  });

  let invoiceId = "";
  await check("idempotency: same key + body runs once and replays", async () => {
    const body = { customerId, invoiceDate: "2026-05-01", lines: [{ itemId, quantity: 3 }] };
    const a = await rest(keys.drafter, "POST", "/invoices", body, { "idempotency-key": "inv-001" });
    const b = await rest(keys.drafter, "POST", "/invoices", body, { "idempotency-key": "inv-001" });
    assertEq(a.status, 200, "first");
    assertEq(b.json.id, a.json.id, "same invoice");
    assertEq(b.headers.get("idempotent-replayed"), "true", "replayed header");
    invoiceId = a.json.id;
    const rows = await db.select().from(arInvoices).where(eq(arInvoices.organizationId, t.org.id));
    assertEq(rows.length, 1, "one invoice");
  });

  await check("idempotency: same key + different body → 422", async () => {
    const r = await rest(
      keys.drafter,
      "POST",
      "/invoices",
      { customerId, invoiceDate: "2026-05-02", lines: [{ itemId }] },
      { "idempotency-key": "inv-001" }
    );
    assertEq(r.status, 422, "status");
    assertEq(r.json.error.code, "idempotency_conflict", "code");
  });

  await check("draft-only agent can't post (403) and the error says why", async () => {
    const r = await rest(keys.drafter, "POST", `/invoices/${invoiceId}/post`);
    assertEq(r.status, 403, "status");
    assert(/"post" scope/.test(r.json.error.message), r.json.error.message);
  });

  await check("validation errors name the field (400)", async () => {
    const r = await rest(keys.owner, "POST", "/invoices", { customerId, invoiceDate: "May 1", lines: [] });
    assertEq(r.status, 400, "status");
    assertEq(r.json.error.code, "invalid_input", "code");
    assert(r.json.error.details.issues.length >= 1, "issues");
  });

  await check("a human posts the agent's draft; aging reflects it", async () => {
    const p = await rest(keys.owner, "POST", `/invoices/${invoiceId}/post`);
    assertEq(p.json.status, "open", "posted");
    const aging = await rest(keys.reader, "GET", "/reports/ar-aging?asOf=2026-05-01");
    assertEq(money(aging.json.totals.total).toFixed(2), "1200.00", "aging total");
  });

  await check("read-only agent can't write (403)", async () => {
    const r = await rest(keys.reader, "POST", "/customers", { name: "Nope" });
    assertEq(r.status, 403, "status");
  });

  section("MCP");
  await check("initialize negotiates the protocol and ships instructions", async () => {
    const r = await mcp(keys.poster, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assertEq(r.json.result.protocolVersion, "2025-06-18", "version echo");
    assert(r.json.result.capabilities.tools, "tools capability");
    assert(/whoami/.test(r.json.result.instructions), "instructions");
    const odd = await mcp(keys.poster, "initialize", { protocolVersion: "1999-01-01" });
    assertEq(odd.json.result.protocolVersion, "2025-11-25", "falls back to latest");
  });

  await check("notifications get 202 and no body", async () => {
    const req = new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${keys.poster}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assertEq((await handleMcp(req)).status, 202, "status");
  });

  await check("tools/list is filtered by what the key can do", async () => {
    const reader = (await mcp(keys.reader, "tools/list")).json.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    const drafter = (await mcp(keys.drafter, "tools/list")).json.result.tools as Array<{ name: string }>;
    const owner = (await mcp(keys.owner, "tools/list")).json.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    assert(reader.every((x) => x.annotations.readOnlyHint), "reader sees only read tools");
    assert(drafter.some((x) => x.name === "create_invoice"), "drafter can create");
    assert(!drafter.some((x) => x.name === "post_invoice"), "drafter can't see post_invoice");
    const createInvoice = owner.find((x) => x.name === "create_invoice")!;
    assert(createInvoice.inputSchema.properties.dry_run, "dry_run arg");
    assert(createInvoice.inputSchema.properties.idempotency_key, "idempotency_key arg");
  });

  await check("tools/call whoami returns structured content", async () => {
    const r = await callTool(keys.poster, "whoami");
    assert(!r.isError, "not an error");
    assertEq((r.structuredContent.actor as { agentName: string }).agentName, "Poster", "agent");
    assert(r.content[0].text.includes("Poster"), "text content");
  });

  await check("tool errors come back as isError results with the code", async () => {
    const r = await callTool(keys.poster, "create_invoice", { customerId, invoiceDate: "2026-05-03", lines: [] });
    assertEq(r.isError, true, "isError");
    assert(r.content[0].text.startsWith("Error (invalid_input)"), r.content[0].text);
  });

  await check("unknown tool is a JSON-RPC error (-32602)", async () => {
    const r = await mcp(keys.poster, "tools/call", { name: "transfer_all_money", arguments: {} });
    assertEq(r.json.error.code, -32602, "code");
  });

  await check("posting agent: under its limit posts; over it the draft waits for review", async () => {
    const small = await callTool(keys.poster, "create_invoice", {
      customerId,
      invoiceDate: "2026-05-04",
      lines: [{ itemId, quantity: 2 }],
      post: true,
    });
    assert(!small.isError, small.content[0].text);
    assertEq(small.structuredContent.status, "open", "posted");

    const big = await callTool(keys.poster, "create_invoice", {
      customerId,
      invoiceDate: "2026-05-04",
      lines: [{ itemId, quantity: 5 }],
      post: true,
    });
    assert(!big.isError, big.content[0].text);
    assertEq(big.structuredContent.status, "draft", "kept as draft");
    assert(big.content[0].text.startsWith("NEEDS HUMAN REVIEW"), big.content[0].text);
    assert(/posting limit/.test(big.content[0].text), "says why");
  });

  await check("the over-limit draft shows up in the review queue", async () => {
    const r = await rest(keys.owner, "GET", "/review-queue");
    const mine = (r.json as Array<{ amount: string; agentName: string; reason: string }>).filter(
      (i) => i.agentName === "Poster"
    );
    assertEq(mine.length, 1, "one item");
    assertEq(money(mine[0].amount).toFixed(2), "2000.00", "amount");
    assertEq(mine[0].reason, "agent_draft", "reason");
  });

  await check("post_invoice over the limit is approval_required and leaves the draft", async () => {
    const [draft] = await db
      .select()
      .from(arInvoices)
      .where(and(eq(arInvoices.organizationId, t.org.id), eq(arInvoices.totalAmount, "2000.0000")));
    const r = await callTool(keys.poster, "post_invoice", { id: draft.id });
    assertEq(r.isError, true, "isError");
    assert(r.content[0].text.startsWith("Error (approval_required)"), r.content[0].text);
    const [after] = await db.select().from(arInvoices).where(eq(arInvoices.id, draft.id));
    assertEq(after.status, "draft", "still draft");
  });

  await check("MCP dry run of a payment previews auto-apply", async () => {
    const r = await callTool(keys.poster, "create_customer_payment", {
      customerId,
      paymentDate: "2026-05-10",
      method: "ach",
      amount: "500",
      dry_run: true,
    });
    assert(!r.isError, r.content[0].text);
    assert(r.content[0].text.startsWith("DRY RUN"), "labelled");
    const result = r.structuredContent.result as { applications: unknown[] };
    assertEq(result.applications.length, 1, "applied to one invoice");
  });

  await check("batch requests answer each call", async () => {
    const req = new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${keys.reader}`, "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: "a", method: "ping" },
        { jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "list_review_queue", arguments: {} } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    });
    const body = (await (await handleMcp(req)).json()) as Array<{ id: string }>;
    assertEq(body.length, 2, "two responses");
    assertEq(body.map((b) => b.id).join(","), "a,b", "ids");
  });

  await check("MCP actions are audited as the agent via the mcp channel", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, t.org.id), eq(auditLog.agentId, keys.posterAgentId)));
    assert(rows.length > 0, "rows");
    assert(rows.every((r) => r.channel === "mcp" && r.actorType === "agent" && r.apiKeyId), "attribution");
  });

  await deleteOrgs("api-test-");
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
