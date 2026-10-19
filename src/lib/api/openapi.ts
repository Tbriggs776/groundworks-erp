import { inputJsonSchema } from "./json-schema";
import { OPERATIONS, isMutation } from "./operations";

type Json = Record<string, unknown>;

/**
 * OpenAPI 3.1 document for /api/v1, generated from the operation registry
 * so the spec can't drift from the code. Served at /api/v1/openapi.json.
 */
export function openApiDocument(origin: string): Json {
  const paths: Record<string, Json> = {};

  for (const op of OPERATIONS) {
    const schema = inputJsonSchema(op);
    const props = (schema.properties ?? {}) as Record<string, Json>;
    const required = new Set((schema.required ?? []) as string[]);
    const pathParams = Array.from(op.path.matchAll(/\{(\w+)\}/g)).map((m) => m[1]);

    const parameters: Json[] = pathParams.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    }));

    let requestBody: Json | undefined;
    if (op.method === "GET" || op.method === "DELETE") {
      for (const [name, prop] of Object.entries(props)) {
        if (pathParams.includes(name)) continue;
        parameters.push({
          name,
          in: "query",
          required: required.has(name),
          ...(prop.description ? { description: prop.description } : {}),
          schema: prop,
        });
      }
    } else {
      const bodyProps = Object.fromEntries(
        Object.entries(props).filter(([name]) => !pathParams.includes(name))
      );
      requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              ...schema,
              properties: bodyProps,
              required: Array.from(required).filter((r) => !pathParams.includes(r)),
            },
          },
        },
      };
      parameters.push(
        {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: "Any unique string (a UUID is ideal). Retries with the same key and body run once.",
          schema: { type: "string", maxLength: 255 },
        },
        {
          name: "X-Dry-Run",
          in: "header",
          required: false,
          description: "true = validate and simulate (numbers, GL lines) without saving.",
          schema: { type: "boolean" },
        }
      );
    }

    const path = `/${op.path.replace(/^\//, "")}`;
    paths[path] ??= {};
    paths[path][op.method.toLowerCase()] = {
      operationId: op.name,
      summary: op.title,
      description: op.description,
      tags: [op.group],
      "x-required-scope": op.scope,
      ...(op.destructive ? { "x-destructive": true } : {}),
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses: {
        "200": {
          description: isMutation(op) ? "The resulting record." : "OK",
          content: { "application/json": { schema: { type: "object" } } },
        },
        default: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Groundworks Accounting API",
      version: "1.0.0",
      description:
        "Double-entry small-business accounting for people and AI agents. Every operation here is also an MCP tool at /api/mcp. Money is a decimal string; dates are YYYY-MM-DD.",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }],
    tags: ["Context", "Accounting", "Sales", "Expenses", "Reports", "Review"].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "API key (gwk_…) from Settings → API Keys." },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  enum: [
                    "invalid_input", "unauthenticated", "forbidden", "not_found", "method_not_allowed",
                    "conflict", "invalid_state", "approval_required", "posting_failed",
                    "idempotency_conflict", "rate_limited", "internal",
                  ],
                },
                message: { type: "string" },
                details: { type: "object" },
                requestId: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}
