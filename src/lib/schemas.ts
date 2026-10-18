import { z } from "zod";
import { isValid, parseISO } from "date-fns";
import { money } from "@/lib/money";

/**
 * Shared zod building blocks for service inputs. These schemas are the
 * single source of truth for validation AND for the JSON Schema the REST
 * API (OpenAPI) and MCP server publish, so every `.describe()` here is
 * documentation an AI agent will read. Write them for that reader.
 */

export const id = z.uuid();

/** YYYY-MM-DD, and a real calendar date. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((s) => isValid(parseISO(s)), "Not a real calendar date.");

/**
 * Money in, as a decimal string or a JSON number ("1250.00" or 1250).
 * Normalized to a 4-decimal string. Strings are preferred: they never pick
 * up binary-float noise.
 */
export const amount = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^-?\d+(\.\d{1,4})?$/.test(s), "Use a decimal amount with at most 4 decimal places, e.g. \"1250.00\".")
  .transform((s) => money(s).toFixed(4));

export const positiveAmount = amount.refine(
  (s) => money(s).gt(0),
  "Amount must be greater than zero."
);

export const nonNegativeAmount = amount.refine(
  (s) => money(s).gte(0),
  "Amount cannot be negative."
);

/** ISO 4217 code, upper-cased. */
export const currency = z
  .string()
  .trim()
  .length(3, "Use a 3-letter ISO currency code.")
  .transform((s) => s.toUpperCase());

/** Optional free text: trims, and treats "" as absent. */
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((s) => (s ? s : null));

export const pagination = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Max rows to return (1–200, default 50)."),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Rows to skip, for paging."),
};

export type Page<T> = { data: T[]; hasMore: boolean; limit: number; offset: number };

/** Fetch limit+1 rows, then call this to trim and compute hasMore. */
export function toPage<T>(rows: T[], limit: number, offset: number): Page<T> {
  return {
    data: rows.slice(0, limit),
    hasMore: rows.length > limit,
    limit,
    offset,
  };
}

/** Escape LIKE wildcards in user search text. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
