import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * Liveness + database check for uptime monitoring. Public, says nothing
 * beyond up / down.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ status: "ok", db: "ok", ms: Date.now() - started }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "degraded", db: "unreachable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
