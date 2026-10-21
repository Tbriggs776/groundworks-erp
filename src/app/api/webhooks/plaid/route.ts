import { after } from "next/server";
import { runAs, systemActor } from "@/lib/actor";
import { plaidConfigured } from "@/lib/banking/feeds/plaid";
import { connectionForItem, handleFeedWebhook, type PlaidWebhook } from "@/lib/banking/feeds/service";
import { verifyPlaidWebhook } from "@/lib/banking/feeds/webhook";

/**
 * POST /api/webhooks/plaid: Plaid says a bank has new transactions, or its
 * sign-in broke or was repaired. Believed only with a valid Plaid-Verification
 * signature over this exact body. Plaid wants an answer within seconds, so the
 * sync runs after the response.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!plaidConfigured()) return new Response("Bank feeds aren't configured.", { status: 503 });
  const body = await request.text();
  if (!(await verifyPlaidWebhook(body, request.headers.get("plaid-verification")))) {
    return new Response("Bad signature.", { status: 401 });
  }
  let event: PlaidWebhook;
  try {
    event = JSON.parse(body) as PlaidWebhook;
  } catch {
    return new Response("Bad JSON.", { status: 400 });
  }
  const conn = await connectionForItem(event.item_id);
  if (!conn) return new Response("ok");
  after(() =>
    runAs(systemActor(conn.organizationId), (ctx) => handleFeedWebhook(ctx, conn.id, event)).catch((e) =>
      console.warn(`[plaid] webhook ${event.webhook_type}:${event.webhook_code} for ${conn.id} failed:`, e instanceof Error ? e.message : e)
    )
  );
  return new Response("ok");
}
