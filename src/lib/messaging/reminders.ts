import { differenceInCalendarDays, parseISO } from "date-fns";
import { sql } from "drizzle-orm";
import { runAs, systemActor, type Ctx } from "@/lib/actor";
import { invoiceSettledSql } from "@/lib/ar/balances";
import { emailConfigured } from "@/lib/email";
import { loadSettings, sendDocumentEmail } from "./service";

/**
 * AUTOMATIC PAYMENT REMINDERS, from the daily run. A company lists days
 * relative to the due date (-3, 0, 7, 30). Each open invoice gets the
 * reminder for the latest of those days it has reached, once, to the email
 * saved on the customer. A day missed by more than a week is skipped, so
 * turning reminders on doesn't email every old invoice at once; a failed
 * send is tried again the next day.
 */

const GRACE_DAYS = 7;

/** Invoices due a reminder on `asOf`, with the reminder day each has reached. */
export async function dueReminders(ctx: Ctx, asOf: string, days: number[]): Promise<Array<{ invoiceId: string; offset: number }>> {
  const rows = await ctx.tx.execute<{ id: string; due_date: string; last_offset: number | null }>(sql`
    SELECT i.id, i.due_date::text,
           (SELECT MAX(m.reminder_offset) FROM email_messages m
             WHERE m.organization_id = i.organization_id AND m.document_type = 'invoice'
               AND m.document_id = i.id AND m.kind = 'reminder' AND m.status <> 'failed') AS last_offset
      FROM ar_invoices i
      JOIN customers c ON c.id = i.customer_id
     WHERE i.organization_id = ${ctx.actor.organizationId}
       AND i.status = 'open'
       AND COALESCE(c.email, '') <> ''
       AND i.total_amount - ${invoiceSettledSql(sql`i.id`)} > 0
  `);
  const out: Array<{ invoiceId: string; offset: number }> = [];
  for (const r of rows) {
    const late = differenceInCalendarDays(parseISO(asOf), parseISO(r.due_date));
    const reached = days.filter((d) => late >= d);
    if (reached.length === 0) continue;
    const offset = Math.max(...reached);
    if (late - offset > GRACE_DAYS) continue;
    if (r.last_offset !== null && r.last_offset >= offset) continue;
    out.push({ invoiceId: r.id, offset });
  }
  return out;
}

export async function runRemindersForOrg(organizationId: string, asOf: string) {
  const actor = systemActor(organizationId);
  const settings = await runAs(actor, (ctx) => loadSettings(ctx));
  if (!settings.remindersEnabled || !emailConfigured()) return { checked: 0, sent: 0, failed: 0, errors: [] as string[] };
  const due = await runAs(actor, (ctx) => dueReminders(ctx, asOf, settings.reminderDays));
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const d of due) {
    try {
      const m = await runAs(actor, (ctx) => sendDocumentEmail(ctx, { documentType: "invoice", documentId: d.invoiceId, reminder: true }, { asOf }));
      if (m.status === "failed") failed++;
      else sent++;
    } catch (err) {
      failed++;
      errors.push(`${d.invoiceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { checked: due.length, sent, failed, errors };
}
