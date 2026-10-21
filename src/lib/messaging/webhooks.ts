import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailMessages } from "@/lib/db/schema";
import { auditFields, systemActor } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";

/**
 * DELIVERY EVENTS from Resend, signed the Svix way: HMAC-SHA256 over
 * "id.timestamp.body" with the base64 secret after "whsec_", sent as one or
 * more "v1,<signature>" entries. Events older than five minutes are refused
 * (replays). Each event updates the logged email it names; bounces and
 * complaints are also written to the company's audit log.
 */

const TOLERANCE_SECONDS = 5 * 60;

export function verifyWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${body}`).digest();
  return headers.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type ResendEvent = {
  type: string;
  created_at?: string;
  data?: { email_id?: string; bounce?: { message?: string; type?: string } };
};

/** Apply one event to the email it names. Unknown emails and event types are ignored. */
export async function applyEmailEvent(event: ResendEvent): Promise<{ matched: boolean }> {
  const providerId = event.data?.email_id;
  if (!providerId) return { matched: false };
  const [m] = await db.select().from(emailMessages).where(eq(emailMessages.providerId, providerId));
  if (!m) return { matched: false };
  const at = event.created_at ? new Date(event.created_at) : new Date();
  const final = m.status === "bounced" || m.status === "complained";
  switch (event.type) {
    case "email.delivered":
      await db
        .update(emailMessages)
        .set({ status: final ? m.status : "delivered", deliveredAt: at, updatedAt: sql`now()` })
        .where(eq(emailMessages.id, m.id));
      break;
    case "email.delivery_delayed":
      if (m.status === "sent") await db.update(emailMessages).set({ status: "delayed", updatedAt: sql`now()` }).where(eq(emailMessages.id, m.id));
      break;
    case "email.opened":
      await db
        .update(emailMessages)
        .set({ openedAt: sql`COALESCE(${emailMessages.openedAt}, ${at.toISOString()}::timestamptz)`, openCount: sql`${emailMessages.openCount} + 1`, updatedAt: sql`now()` })
        .where(eq(emailMessages.id, m.id));
      break;
    case "email.bounced":
    case "email.complained": {
      const status = event.type === "email.bounced" ? "bounced" : "complained";
      const reason = event.data?.bounce?.message ?? null;
      await db.transaction(async (tx) => {
        await tx
          .update(emailMessages)
          .set({ status, bouncedAt: status === "bounced" ? at : m.bouncedAt, error: reason ?? m.error, updatedAt: sql`now()` })
          .where(eq(emailMessages.id, m.id));
        await writeAudit(
          {
            organizationId: m.organizationId,
            ...auditFields(systemActor(m.organizationId)),
            event: `email.${status}`,
            entityType: m.documentType,
            entityId: m.documentId,
            metadata: { messageId: m.id, to: m.to, reason: reason ?? undefined },
          },
          tx
        );
      });
      break;
    }
    default:
      return { matched: true };
  }
  return { matched: true };
}
