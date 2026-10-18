import { z } from "zod";
import type { Operation } from "./operations";

type Json = Record<string, unknown>;

/** Drop noise agents don't need: $schema, and regexes behind format: uuid. */
function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === "$schema") continue;
    if (k === "pattern" && (node as Json).format === "uuid") continue;
    out[k] = tidy(v);
  }
  return out;
}

const cache = new Map<string, Json>();

/** The operation's input as JSON Schema (the shape callers send). */
export function inputJsonSchema(op: Operation): Json {
  let s = cache.get(op.name);
  if (!s) {
    s = tidy(z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" })) as Json;
    cache.set(op.name, s);
  }
  return s;
}
