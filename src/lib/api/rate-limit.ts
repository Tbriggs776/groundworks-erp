import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

/**
 * Per-key request budget, counted per clock minute in Postgres so every
 * server instance shares it. Default 600/min (10/s), override with
 * API_RATE_LIMIT_PER_MINUTE. A runaway agent loop gets 429s with a
 * Retry-After instead of hammering the books.
 */
export function rateLimitPerMinute(): number {
  const n = Number(process.env.API_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600;
}

export async function consumeRateLimit(apiKeyId: string, limit = rateLimitPerMinute()): Promise<void> {
  const [row] = await db.execute<{ count: number; reset: number }>(sql`
    INSERT INTO api_rate_limits (api_key_id, window_start, count)
    VALUES (${apiKeyId}, date_trunc('minute', now()), 1)
    ON CONFLICT (api_key_id, window_start)
      DO UPDATE SET count = api_rate_limits.count + 1
    RETURNING count,
      ceil(extract(epoch FROM date_trunc('minute', now()) + interval '1 minute' - now()))::int AS reset
  `);
  if (row.count > limit) {
    throw new AppError(
      "rate_limited",
      `Rate limit exceeded: ${limit} requests per minute for this API key. Retry in ${row.reset}s.`,
      { limit, retryAfterSeconds: row.reset }
    );
  }
}

/** Drop finished windows (cron). */
export async function pruneRateLimits(): Promise<number> {
  const rows = await db.execute(sql`DELETE FROM api_rate_limits WHERE window_start < now() - interval '1 hour' RETURNING 1`);
  return rows.length;
}
