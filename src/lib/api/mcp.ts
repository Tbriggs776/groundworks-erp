import { authenticateApiKey, tokenFromHeaders } from "@/lib/agents/authenticate";
import { requestMeta, type Actor } from "@/lib/actor";
import { toAppError } from "@/lib/errors";
import { executeOperation } from "./execute";
import { inputJsonSchema } from "./json-schema";
import { OPERATIONS_BY_NAME, OPERATIONS, isMutation, type Operation } from "./operations";

/**
 * MCP server over Streamable HTTP, stateless: every POST carries its own
 * bearer key, we answer with plain JSON (no SSE stream, no session id), so
 * it runs fine on serverless. Tools come straight from the operation
 * registry, filtered to what the caller's key can actually do.
 *
 * Supported methods: initialize, ping, tools/list, tools/call, and any
 * notification (acknowledged with 202).
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "groundworks", title: "Groundworks Accounting", version: "1.0.0" };

export const SERVER_INSTRUCTIONS = `Groundworks is double-entry accounting for a small business (a QuickBooks Online replacement). You act on the books of one organization.

How to work:
- Call whoami first. It tells you your role, whether you can post or only draft, and any posting limit.
- Never guess ids. Look them up with list_* tools (most accept q for search), and search before creating customers, vendors, or items to avoid duplicates.
- Money is a decimal string like "1250.00" (numbers are accepted). Dates are YYYY-MM-DD.
- Documents start as drafts. Drafts don't touch the ledger. If you can't post (or a document is over your limit, error code approval_required), leave it as a draft: it appears in the human review queue. Tell the user what you drafted and that it awaits review.
- Mutating tools accept dry_run=true to preview the result (numbers, totals, GL lines) without saving. Use it when unsure.
- When retrying a create after a timeout, pass the same idempotency_key so it only happens once.
- Prefer invoices, bills, and payments over manual journal entries for everyday transactions.
- Don't void, reverse, or delete anything unless the user asked for it.
- Errors carry a code (invalid_input, not_found, forbidden, invalid_state, approval_required, posting_failed, …) and a message written for you to relay or act on.`;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function httpJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function toolsFor(actor: Actor) {
  return OPERATIONS.filter((op) => actor.scopes.includes(op.scope)).map((op) => toolDefinition(op));
}

function toolDefinition(op: Operation) {
  const schema = inputJsonSchema(op);
  const mutation = isMutation(op);
  const properties = { ...((schema.properties ?? {}) as Record<string, unknown>) };
  if (mutation) {
    properties.dry_run = {
      type: "boolean",
      description: "Preview only: validate and simulate without saving anything.",
    };
    properties.idempotency_key = {
      type: "string",
      description: "Optional. Reuse the same key when retrying so the action happens once.",
    };
  }
  return {
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema: { ...schema, type: "object", properties },
    annotations: {
      title: op.title,
      readOnlyHint: !mutation,
      destructiveHint: Boolean(op.destructive),
      idempotentHint: !mutation,
      openWorldHint: false,
    },
  };
}

async function callTool(actor: Actor, id: JsonRpcId, params: Record<string, unknown> | undefined): Promise<JsonRpcResponse> {
  const name = params?.name;
  if (typeof name !== "string") return rpcError(id, INVALID_PARAMS, "tools/call needs a tool name.");
  const op = OPERATIONS_BY_NAME.get(name);
  if (!op) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);

  const raw = params?.arguments;
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const dryRun = args.dry_run === true || args.dry_run === "true";
  const idempotencyKey = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;
  delete args.dry_run;
  delete args.idempotency_key;

  const result = await executeOperation(actor, op, args, { dryRun, idempotencyKey });
  if (!result.ok) {
    const e = result.error;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: `Error (${e.code}): ${e.message}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ""}` }],
        structuredContent: { error: e.toJSON() },
      },
    };
  }

  const payload = result.dryRun ? { dryRun: true, result: result.data } : result.data;
  const structured =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { result: payload };
  const review = (structured.review ?? (structured.result as { review?: unknown } | undefined)?.review) as
    | { required: boolean; reason: string }
    | undefined;
  const prefix = [
    result.dryRun ? "DRY RUN: nothing was saved." : "",
    result.replayed ? "Replayed (idempotency key already used)." : "",
    review?.required ? `NEEDS HUMAN REVIEW: ${review.reason}` : "",
  ]
    .filter(Boolean)
    .map((line) => `${line}\n`)
    .join("");
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: `${prefix}${JSON.stringify(payload, null, 2)}` }],
      structuredContent: structured,
    },
  };
}

async function dispatch(actor: Actor, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolsFor(actor) } };
    case "tools/call":
      return callTool(actor, id, msg.params);
    default:
      if (isNotification || msg.method.startsWith("notifications/")) return null;
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

function isRequest(m: unknown): m is JsonRpcRequest {
  return (
    !!m &&
    typeof m === "object" &&
    (m as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (m as JsonRpcRequest).method === "string"
  );
}

export async function handleMcp(request: Request): Promise<Response> {
  let actor: Actor;
  try {
    actor = await authenticateApiKey(tokenFromHeaders(request.headers), "mcp", requestMeta(request.headers));
  } catch (err) {
    const e = toAppError(err);
    if (e.code === "rate_limited") {
      return httpJson(rpcError(null, -32002, e.message), 429, {
        "retry-after": String(e.details?.retryAfterSeconds ?? 60),
      });
    }
    return httpJson(rpcError(null, -32001, e.message), 401, {
      "www-authenticate": 'Bearer realm="groundworks", error="invalid_token"',
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return httpJson(rpcError(null, PARSE_ERROR, "Parse error: body is not valid JSON."), 400);
  }

  const batch = Array.isArray(body);
  const messages = batch ? (body as unknown[]) : [body];
  if (messages.length === 0) return httpJson(rpcError(null, INVALID_REQUEST, "Empty batch."), 400);

  const responses: JsonRpcResponse[] = [];
  for (const m of messages) {
    if (!isRequest(m)) {
      // A response or garbage from the client: nothing to answer unless malformed request.
      if (m && typeof m === "object" && "method" in m) {
        responses.push(rpcError(null, INVALID_REQUEST, "Invalid JSON-RPC request."));
      }
      continue;
    }
    const r = await dispatch(actor, m);
    if (r) responses.push(r);
  }

  if (responses.length === 0) return new Response(null, { status: 202 });
  return httpJson(batch ? responses : responses[0], 200, { "x-request-id": actor.requestId });
}
