import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/actor";

/**
 * Who has a verified second factor. Supabase Auth keeps factors in
 * `auth.mfa_factors`; we read it directly so access reviews and the people
 * list can show MFA status for everyone, not just the signed-in user.
 *
 * Runs in a savepoint: if the auth schema isn't readable (a locked-down
 * project), the outer transaction survives and callers get `null` per
 * user, meaning "unknown".
 */
export async function mfaStatus(tx: Tx, userIds: string[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>(userIds.map((id) => [id, null]));
  if (userIds.length === 0) return out;
  try {
    const rows = await tx.transaction((sp) =>
      sp.execute<{ user_id: string }>(sql`
        SELECT DISTINCT user_id::text AS user_id
          FROM auth.mfa_factors
         WHERE status = 'verified'
           AND user_id IN (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `)
    );
    for (const id of userIds) out.set(id, false);
    for (const r of rows) out.set(r.user_id, true);
  } catch {
    // Leave as unknown.
  }
  return out;
}

export async function hasVerifiedFactor(tx: Tx, userId: string): Promise<boolean | null> {
  return (await mfaStatus(tx, [userId])).get(userId) ?? null;
}
