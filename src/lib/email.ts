/**
 * Outbound email: invitations, and documents and reminders companies send
 * their customers and vendors (src/lib/messaging/). Password-reset links
 * are sent by Supabase Auth, not from here.
 *
 * Uses Resend's HTTP API when RESEND_API_KEY and EMAIL_FROM are set. When
 * they aren't (local dev), nothing is sent and the caller gets
 * `{ sent: false }` so the UI can say so. EMAIL_TRANSPORT=memory (never in
 * production) keeps messages in `memoryOutbox` instead, for the e2e suites.
 */

export type Email = {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  /** Display name shown with EMAIL_FROM's address (a company's name). */
  fromName?: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

export type SendResult = { sent: true; id: string | null } | { sent: false; reason: string };

/** Messages "sent" with EMAIL_TRANSPORT=memory. Any recipient at fail.test is refused. */
export const memoryOutbox: Array<Email & { id: string }> = [];

const memoryTransport = () => process.env.EMAIL_TRANSPORT === "memory" && process.env.NODE_ENV !== "production";

export function emailConfigured(): boolean {
  return memoryTransport() || Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/** EMAIL_FROM's address, shown under another display name. */
function fromHeader(name?: string): string {
  const from = process.env.EMAIL_FROM ?? "";
  if (!name) return from;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return `"${name.replace(/["<>\r\n]/g, "").slice(0, 100)}" <${address}>`;
}

export async function sendEmail(email: Email): Promise<SendResult> {
  const to = Array.isArray(email.to) ? email.to : [email.to];
  if (memoryTransport()) {
    if ([...to, ...(email.cc ?? [])].some((a) => a.endsWith("@fail.test"))) return { sent: false, reason: "The email service refused the message." };
    const id = `mem_${memoryOutbox.length + 1}_${Date.now()}`;
    memoryOutbox.push({ ...email, id });
    return { sent: true, id };
  }
  if (!emailConfigured()) return { sent: false, reason: "Email isn't configured (RESEND_API_KEY / EMAIL_FROM)." };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: fromHeader(email.fromName),
        to,
        ...(email.cc?.length ? { cc: email.cc } : {}),
        ...(email.bcc?.length ? { bcc: email.bcc } : {}),
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.attachments?.length
          ? { attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })) }
          : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[email] send failed", res.status, body.slice(0, 300));
      return { sent: false, reason: `The email service answered ${res.status}.` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { sent: true, id: body.id ?? null };
  } catch (err) {
    console.error("[email] send failed", err);
    return { sent: false, reason: "Couldn't reach the email service." };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function invitationEmail(opts: {
  to: string;
  inviter: string;
  workspaceName: string;
  companyNames: string[];
  link: string;
}): Email {
  const companies = opts.companyNames.length ? ` (${opts.companyNames.join(", ")})` : "";
  const subject = `${opts.inviter} invited you to ${opts.workspaceName} on Groundworks`;
  const text = [
    `${opts.inviter} invited you to join ${opts.workspaceName}${companies} on Groundworks.`,
    "",
    `Accept the invitation: ${opts.link}`,
    "",
    "The link works once and expires in 7 days. Sign in (or create an account) with this email address to accept.",
    "If you weren't expecting this, you can ignore it.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1B2A4E;line-height:1.5">
<div style="font-family:Georgia,serif;letter-spacing:0.18em;font-weight:600;color:#1B2A4E;border-bottom:2px solid #C9A961;padding-bottom:8px;margin-bottom:16px">GROUNDWORKS</div>
<p><strong>${escapeHtml(opts.inviter)}</strong> invited you to join <strong>${escapeHtml(opts.workspaceName)}</strong>${escapeHtml(companies)} on Groundworks.</p>
<p><a href="${escapeHtml(opts.link)}" style="display:inline-block;background:#1B2A4E;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Accept invitation</a></p>
<p style="color:#5C6880;font-size:13px">The link works once and expires in 7 days. Sign in (or create an account) with ${escapeHtml(opts.to)} to accept. If you weren't expecting this, you can ignore it.</p>
</body></html>`;
  return { to: opts.to, subject, text, html };
}
