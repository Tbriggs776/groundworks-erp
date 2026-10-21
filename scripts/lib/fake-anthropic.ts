/**
 * A fake Anthropic Messages API for the receipt reading tests: it answers
 * POST /v1/messages with the fields set for the attached file (looked up by
 * the SHA-256 of its bytes), the way structured output would, and records
 * every request so tests can check the model, beta header, fallbacks,
 * effort, and output format. Knobs make it refuse, fail, or answer with
 * something that isn't JSON.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_ANTHROPIC_KEY = "sk-ant-fake";

export type FakeRequest = {
  model: string;
  beta: string | null;
  apiKey: string | null;
  body: {
    model: string;
    fallbacks?: unknown;
    output_config?: { effort?: string; format?: { type?: string; schema?: unknown } };
    system?: string;
    messages: Array<{ role: string; content: Array<{ type: string; source?: { media_type?: string; data?: string } }> }>;
  };
};

export type FakeAnthropic = {
  url: string;
  state: {
    /** Fields to answer with, by SHA-256 (hex) of the file's bytes. */
    receipts: Map<string, Record<string, unknown>>;
    /** Answer for a file not in `receipts` (null: an "other" document with nothing on it). */
    fallback: Record<string, unknown> | null;
    /** The next answers: refuse, fail with a 500, or say something that isn't JSON. */
    next: Array<"refusal" | "error" | "garbage">;
    requests: FakeRequest[];
  };
  set: (bytes: Buffer, fields: Record<string, unknown>) => void;
  close: () => Promise<void>;
};

const EMPTY = {
  documentType: "other",
  vendorName: null,
  date: null,
  dueDate: null,
  total: null,
  subtotal: null,
  tax: null,
  tip: null,
  currency: null,
  paymentMethod: null,
  cardLast4: null,
  reference: null,
  description: null,
};

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeAnthropic(opts: { port?: number } = {}): Promise<FakeAnthropic> {
  let n = 0;
  const state: FakeAnthropic["state"] = { receipts: new Map(), fallback: null, next: [], requests: [] };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "request-id": `req_fake_${n}` });
      res.end(JSON.stringify(json));
    };
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return send(404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const apiKey = (req.headers["x-api-key"] as string | undefined) ?? bearer ?? null;
    if (apiKey !== FAKE_ANTHROPIC_KEY) return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const b = JSON.parse(await body(req)) as FakeRequest["body"];
    state.requests.push({ model: b.model, beta: (req.headers["anthropic-beta"] as string | undefined) ?? null, apiKey, body: b });
    n++;
    const next = state.next.shift();
    if (next === "error") return send(500, { type: "error", error: { type: "api_error", message: "Internal server error" } });
    const message = (content: Array<{ type: "text"; text: string }>, stop: string, extra: Record<string, unknown> = {}) =>
      send(200, {
        id: `msg_fake_${n}`,
        type: "message",
        role: "assistant",
        model: b.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 1500, output_tokens: 120 },
        ...extra,
      });
    if (next === "refusal") {
      return message([], "refusal", { stop_details: { type: "refusal", category: null, explanation: "Declined." } });
    }
    if (next === "garbage") return message([{ type: "text", text: "Sorry, I can't tell." }], "end_turn");
    const file = b.messages[0]?.content.find((c) => c.type === "image" || c.type === "document");
    const fields = file?.source?.data ? state.receipts.get(sha(Buffer.from(file.source.data, "base64"))) : undefined;
    return message([{ type: "text", text: JSON.stringify({ ...EMPTY, ...(fields ?? state.fallback ?? {}) }) }], "end_turn");
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    set: (bytes, fields) => {
      state.receipts.set(sha(bytes), fields);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
