import { applyEmailEvent, verifyWebhook, type ResendEvent } from "@/lib/messaging/webhooks";

/**
 * POST /api/webhooks/resend: delivery, bounce, complaint, and open events
 * for emails the app sent. Verified with RESEND_WEBHOOK_SECRET (the signing
 * secret Resend shows for the webhook).
 */
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("Email tracking isn't configured.", { status: 503 });
  const body = await request.text();
  const ok = verifyWebhook(
    secret,
    { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") },
    body
  );
  if (!ok) return new Response("Bad signature.", { status: 401 });
  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return new Response("Bad JSON.", { status: 400 });
  }
  await applyEmailEvent(event);
  return new Response("ok");
}
