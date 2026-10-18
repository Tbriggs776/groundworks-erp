import { authenticateApiKey, tokenFromHeaders } from "@/lib/agents/authenticate";
import { AppError, toAppError } from "@/lib/errors";
import { executeOperation } from "./execute";
import { OPERATIONS, matchOperation } from "./operations";
import { openApiDocument } from "./openapi";

/**
 * REST surface: /api/v1/<path>, generated from the operation registry.
 *
 *   Auth          Authorization: Bearer gwk_…   (or x-api-key)
 *   Input         GET/DELETE → query string; POST/PATCH → JSON body;
 *                 path params ({id}) always win
 *   Idempotency   Idempotency-Key: <uuid>       (mutations)
 *   Dry run       X-Dry-Run: true  or  ?dry_run=true
 *   Errors        { "error": { code, message, details?, requestId } }
 */

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function errorResponse(err: AppError, requestId?: string, extra: Record<string, string> = {}) {
  return json({ error: { ...err.toJSON(), ...(requestId ? { requestId } : {}) } }, err.status, {
    ...(requestId ? { "x-request-id": requestId } : {}),
    ...extra,
  });
}

function truthy(v: string | null): boolean {
  return v === "true" || v === "1";
}

export async function handleRest(request: Request, segments: string[]): Promise<Response> {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);

  if (method === "GET" && segments.length === 1 && segments[0] === "openapi.json") {
    return json(openApiDocument(url.origin), 200, { "cache-control": "public, max-age=300" });
  }

  const match = matchOperation(method, segments);
  if (!match) {
    const allowed = Array.from(
      new Set(OPERATIONS.filter((o) => matchOperation(o.method, segments)).map((o) => o.method))
    );
    if (allowed.length > 0) {
      return errorResponse(
        new AppError("method_not_allowed", `${method} is not supported here. Allowed: ${allowed.join(", ")}.`),
        undefined,
        { allow: allowed.join(", ") }
      );
    }
    return errorResponse(
      new AppError("not_found", `No endpoint ${method} /api/v1/${segments.join("/")}. See /api/v1/openapi.json.`)
    );
  }

  let actor;
  try {
    actor = await authenticateApiKey(tokenFromHeaders(request.headers), "api");
  } catch (err) {
    return errorResponse(toAppError(err), undefined, {
      "www-authenticate": 'Bearer realm="groundworks"',
    });
  }

  let input: Record<string, unknown> = {};
  if (method === "GET" || method === "DELETE") {
    for (const [k, v] of url.searchParams) {
      if (k !== "dry_run") input[k] = v;
    }
  } else {
    const text = await request.text();
    if (text.trim()) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return errorResponse(new AppError("invalid_input", "Request body must be a JSON object."), actor.requestId);
        }
        input = parsed as Record<string, unknown>;
      } catch {
        return errorResponse(new AppError("invalid_input", "Request body is not valid JSON."), actor.requestId);
      }
    }
  }
  input = { ...input, ...match.params };

  const result = await executeOperation(actor, match.op, input, {
    dryRun: truthy(request.headers.get("x-dry-run")) || truthy(url.searchParams.get("dry_run")),
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
  });

  if (!result.ok) return errorResponse(result.error, actor.requestId);
  const headers: Record<string, string> = { "x-request-id": actor.requestId };
  if (result.replayed) headers["idempotent-replayed"] = "true";
  if (result.dryRun) {
    return json({ dryRun: true, result: result.data }, 200, headers);
  }
  return json(result.data, 200, headers);
}
