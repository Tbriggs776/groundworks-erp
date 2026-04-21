import { NextResponse } from "next/server";
import { eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { organizations } from "@/lib/db/schema";
import { runAutoReversalsForOrg } from "@/lib/gl/auto-reversal";
import { runRecurringForOrg } from "@/lib/gl/recurring";

/**
 * Daily cron entry point. Called by Vercel Cron (see vercel.json).
 *
 * Auth: the request must carry `Authorization: Bearer <CRON_SECRET>`. Vercel
 * Cron attaches that header automatically when CRON_SECRET is set on the
 * project. This prevents random hits from the internet triggering posts.
 *
 * Work performed (per organization):
 *   1. Generate auto-reversals for any journals whose auto_reverse_date
 *      has arrived
 *   2. Generate recurring JEs due today
 *
 * Returns a summary. Errors on individual orgs don't halt the whole run;
 * each org's result is captured independently.
 */
export const dynamic = "force-dynamic";

type OrgResult = {
  organizationId: string;
  slug: string;
  autoReversals: { checked: number; generated: number; errors: number };
  recurring: { checked: number; generated: number; errors: number };
};

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const asOfDate = new Date().toISOString().slice(0, 10);
  const orgs = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(isNull(organizations.deletedAt));

  const results: OrgResult[] = [];
  for (const org of orgs) {
    const [autoReversals, recurring] = await Promise.all([
      runAutoReversalsForOrg(org.id, asOfDate),
      runRecurringForOrg(org.id, asOfDate),
    ]);
    results.push({
      organizationId: org.id,
      slug: org.slug,
      autoReversals: {
        checked: autoReversals.checked,
        generated: autoReversals.generated,
        errors: autoReversals.errors.length,
      },
      recurring: {
        checked: recurring.checked,
        generated: recurring.generated,
        errors: recurring.errors.length,
      },
    });

    // Log full error details server-side for debugging; don't leak to response.
    if (autoReversals.errors.length > 0) {
      console.warn(
        `[cron] ${org.slug} auto-reversal errors:`,
        autoReversals.errors
      );
    }
    if (recurring.errors.length > 0) {
      console.warn(`[cron] ${org.slug} recurring errors:`, recurring.errors);
    }
  }

  return NextResponse.json({
    ranAt: new Date().toISOString(),
    asOfDate,
    organizations: results,
  });
}

// Vercel Cron sends GET in some configurations; accept both.
export { POST as GET };

// Mark ref to satisfy eslint; not used directly but the `organizations`
// import is needed above for the deleted_at filter.
void eq;
