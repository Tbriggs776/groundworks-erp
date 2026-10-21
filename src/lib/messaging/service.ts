import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agents,
  arInvoices,
  companyProfiles,
  customers,
  EMAIL_DOCUMENT_TYPES,
  emailMessages,
  emailSettings,
  organizations,
  profiles,
  vendors,
  type EmailTemplateKey,
  type EmailTemplates,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { markPurchaseOrderSent, getPurchaseOrder } from "@/lib/ap/purchase-orders";
import { getCreditMemo } from "@/lib/ar/credit-memos";
import { getEstimate } from "@/lib/ar/estimates";
import { getInvoice } from "@/lib/ar/invoices";
import { getSalesReceipt } from "@/lib/ar/sales-receipts";
import { customerStatement } from "@/lib/ar/statements";
import { writeAudit } from "@/lib/audit";
import { emailConfigured, sendEmail } from "@/lib/email";
import { AppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";
import { documentPdf, purchaseOrderPdf, statementPdf, type PdfFile } from "@/lib/pdf/documents";
import { id, isoDate, pagination, toPage } from "@/lib/schemas";
import { emailHtml, fill, TEMPLATE_KEYS, templateFor, type TemplateVars } from "./templates";

/**
 * EMAILING DOCUMENTS. Invoices, estimates, sales receipts, credit memos,
 * statements, and payment reminders go to customers; purchase orders to
 * vendors. Each email carries the document's PDF, comes from the app's
 * sending address under the company's name, and replies go to the
 * company. Every send is logged in email_messages, which the email
 * service's delivery events (webhooks.ts) keep up to date.
 *
 * People may email any address. Agents (and the daily reminder run) may
 * only email the addresses saved on the customer or vendor.
 */

const day = (d: string) => format(parseISO(d), "MMM d, yyyy");
const today = () => format(new Date(), "yyyy-MM-dd");
const emails = z.array(z.email().max(254)).max(10);

export const SendEmailSchema = z.object({
  documentType: z.enum(EMAIL_DOCUMENT_TYPES),
  documentId: id.describe("The document; for a statement, the customer."),
  reminder: z.boolean().optional().describe("Invoices only: send a payment reminder for what's still owed."),
  to: emails.optional().describe("Defaults to the email on the customer or vendor. Agents can only use addresses saved there."),
  cc: emails.optional(),
  subject: z.string().trim().min(1).max(300).optional().describe("Defaults to the company's template. {placeholders} are filled in."),
  message: z.string().trim().min(1).max(10_000).optional().describe("Plain text. Defaults to the company's template."),
  statementFrom: isoDate.optional().describe("Statements: first day of activity shown."),
  statementTo: isoDate.optional().describe("Statements: the statement date."),
});
export type SendEmailInput = z.input<typeof SendEmailSchema>;

export const ListEmailsSchema = z.object({
  documentType: z.enum(EMAIL_DOCUMENT_TYPES).optional(),
  documentId: id.optional().describe("One document's send history (for statements, the customer)."),
  status: z.enum(["sent", "failed", "delivered", "delayed", "bounced", "complained"]).optional(),
  ...pagination,
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettings(ctx: Ctx) {
  const org = ctx.actor.organizationId;
  const [[row], [co]] = await Promise.all([
    ctx.tx.select().from(emailSettings).where(eq(emailSettings.organizationId, org)),
    ctx.tx
      .select({ name: organizations.name, legalName: companyProfiles.legalName, email: companyProfiles.email })
      .from(organizations)
      .leftJoin(companyProfiles, eq(companyProfiles.organizationId, organizations.id))
      .where(eq(organizations.id, org)),
  ]);
  return {
    company: co?.legalName || co?.name || "",
    replyTo: row?.replyTo ?? null,
    effectiveReplyTo: row?.replyTo || co?.email || null,
    copyTo: row?.copyTo ?? null,
    remindersEnabled: row?.remindersEnabled ?? false,
    reminderDays: row?.reminderDays ?? [-3, 0, 7, 30],
    templates: (row?.templates ?? {}) as EmailTemplates,
  };
}

export async function getEmailSettings(ctx: Ctx) {
  requirePermission(ctx.actor, "read", "viewer", "read email settings");
  const s = await loadSettings(ctx);
  return {
    replyTo: s.replyTo,
    effectiveReplyTo: s.effectiveReplyTo,
    copyTo: s.copyTo,
    remindersEnabled: s.remindersEnabled,
    reminderDays: s.reminderDays,
    templates: Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, templateFor(s.templates, k)])) as Record<EmailTemplateKey, { subject: string; body: string }>,
    customized: TEMPLATE_KEYS.filter((k) => s.templates[k]),
    configured: emailConfigured(),
    trackingConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET),
  };
}

const Template = z.object({ subject: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(10_000) });

export const UpdateEmailSettingsSchema = z.object({
  replyTo: z.email().max(254).nullable().optional().describe("Where replies go. null: the company profile's email."),
  copyTo: z.email().max(254).nullable().optional().describe("BCC'd on every email the company sends. null: none."),
  remindersEnabled: z.boolean().optional().describe("Send payment reminders automatically in the daily run."),
  reminderDays: z
    .array(z.number().int().min(-60).max(365))
    .min(1)
    .max(6)
    .optional()
    .describe("Days relative to the due date: -3 is three days before, 0 the due date, 7 a week late."),
  templates: z
    .partialRecord(z.enum(TEMPLATE_KEYS as [EmailTemplateKey, ...EmailTemplateKey[]]), Template.nullable())
    .optional()
    .describe("Subject and body per document type; null puts the default back."),
});

export async function updateEmailSettings(ctx: Ctx, input: z.input<typeof UpdateEmailSettingsSchema>) {
  requirePermission(ctx.actor, "admin", "admin", "change email settings");
  const d = UpdateEmailSettingsSchema.parse(input);
  const org = ctx.actor.organizationId;
  const current = await loadSettings(ctx);
  const templates: EmailTemplates = { ...current.templates };
  for (const [k, v] of Object.entries(d.templates ?? {}) as Array<[EmailTemplateKey, { subject: string; body: string } | null]>) {
    if (v === null) delete templates[k];
    else templates[k] = v;
  }
  const values = {
    replyTo: d.replyTo === undefined ? current.replyTo : d.replyTo,
    copyTo: d.copyTo === undefined ? current.copyTo : d.copyTo,
    remindersEnabled: d.remindersEnabled ?? current.remindersEnabled,
    reminderDays: d.reminderDays ? [...new Set(d.reminderDays)].sort((a, b) => a - b) : current.reminderDays,
    templates,
  };
  await ctx.tx
    .insert(emailSettings)
    .values({ organizationId: org, ...values })
    .onConflictDoUpdate({ target: emailSettings.organizationId, set: { ...values, updatedAt: sql`now()` } });
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "settings.email.updated",
      entityType: "organization",
      entityId: org,
      metadata: { changed: Object.keys(d), remindersEnabled: values.remindersEnabled, reminderDays: values.reminderDays },
    },
    ctx.tx
  );
  return getEmailSettings(ctx);
}

// ---------------------------------------------------------------------------
// What each document sends
// ---------------------------------------------------------------------------

type Prepared = {
  template: EmailTemplateKey;
  party: { type: "customer" | "vendor"; id: string | null; name: string };
  vars: TemplateVars;
  attachment: () => Promise<PdfFile>;
  afterSend?: () => Promise<void>;
  /** Reminders: days past due. */
  daysLate?: number;
};

function dueStatus(dueDate: string, asOf: string) {
  const late = differenceInCalendarDays(parseISO(asOf), parseISO(dueDate));
  if (late < 0) return `is due on ${day(dueDate)}`;
  if (late === 0) return "is due today";
  return `was due on ${day(dueDate)}, ${late} day${late === 1 ? "" : "s"} ago`;
}

async function prepare(ctx: Ctx, f: z.output<typeof SendEmailSchema>, asOf: string): Promise<Prepared> {
  if (f.reminder && f.documentType !== "invoice") throw new AppError("invalid_input", "Payment reminders are for invoices.");
  switch (f.documentType) {
    case "invoice": {
      const inv = await getInvoice(ctx, { id: f.documentId });
      const fmt = (v: string) => formatMoney(v, { currency: inv.currency });
      if (inv.status !== "open" && inv.status !== "paid") throw new AppError("invalid_state", `Invoice ${inv.invoiceNumber} is ${inv.status}; post it before emailing it.`);
      if (f.reminder && (inv.status !== "open" || !money(inv.openBalance).gt(0))) throw new AppError("invalid_state", `Invoice ${inv.invoiceNumber} has nothing left to pay.`);
      return {
        template: f.reminder ? "reminder" : "invoice",
        party: { type: "customer", id: inv.customerId, name: inv.customerName },
        vars: { number: inv.invoiceNumber, total: fmt(inv.totalAmount), balance: fmt(inv.openBalance), date: day(inv.invoiceDate), due_date: day(inv.dueDate), due_status: dueStatus(inv.dueDate, asOf) },
        attachment: () => documentPdf(ctx, "invoice", inv.id),
        afterSend: async () => {
          await ctx.tx.update(arInvoices).set({ sentAt: sql`now()` }).where(eq(arInvoices.id, inv.id));
        },
        daysLate: f.reminder ? differenceInCalendarDays(parseISO(asOf), parseISO(inv.dueDate)) : undefined,
      };
    }
    case "estimate": {
      const e = await getEstimate(ctx, { id: f.documentId });
      const fmt = (v: string) => formatMoney(v, { currency: e.currency });
      return {
        template: "estimate",
        party: { type: "customer", id: e.customerId, name: e.customerName },
        vars: { number: e.estimateNumber, total: fmt(e.totalAmount), date: day(e.estimateDate) },
        attachment: () => documentPdf(ctx, "estimate", e.id),
      };
    }
    case "sales_receipt": {
      const r = await getSalesReceipt(ctx, { id: f.documentId });
      if (r.status !== "posted") throw new AppError("invalid_state", `Receipt ${r.receiptNumber} is ${r.status}; only posted receipts can be emailed.`);
      return {
        template: "sales_receipt",
        party: { type: "customer", id: r.customerId, name: r.customerName ?? "there" },
        vars: { number: r.receiptNumber, total: formatMoney(r.totalAmount, { currency: r.currency }), date: day(r.receiptDate) },
        attachment: () => documentPdf(ctx, "sales_receipt", r.id),
      };
    }
    case "credit_memo": {
      const m = await getCreditMemo(ctx, { id: f.documentId });
      if (m.status !== "open" && m.status !== "applied") throw new AppError("invalid_state", `Credit memo ${m.memoNumber} is ${m.status}; post it before emailing it.`);
      return {
        template: "credit_memo",
        party: { type: "customer", id: m.customerId, name: m.customerName },
        vars: { number: m.memoNumber, total: formatMoney(m.totalAmount, { currency: m.currency }), date: day(m.memoDate) },
        attachment: () => documentPdf(ctx, "credit_memo", m.id),
      };
    }
    case "purchase_order": {
      const po = await getPurchaseOrder(ctx, { id: f.documentId });
      if (po.status !== "open" && po.status !== "closed") throw new AppError("invalid_state", `${po.poNumber} isn't approved yet; send it once it's open.`);
      return {
        template: "purchase_order",
        party: { type: "vendor", id: po.vendorId, name: po.vendorName },
        vars: { number: po.poNumber, total: formatMoney(po.totalAmount, { currency: po.currency }), date: day(po.poDate) },
        attachment: () => purchaseOrderPdf(ctx, po.id),
        afterSend: async () => {
          if (!po.sentAt) await markPurchaseOrderSent(ctx, { id: po.id });
        },
      };
    }
    case "statement": {
      const s = await customerStatement(ctx, { id: f.documentId, from: f.statementFrom, to: f.statementTo });
      return {
        template: "statement",
        party: { type: "customer", id: s.customer.id, name: s.customer.name },
        vars: { date: day(s.to), balance: formatMoney(s.closingBalance, { currency: s.customer.currency }) },
        attachment: () => statementPdf(ctx, { id: s.customer.id, from: s.from, to: s.to }),
      };
    }
  }
}

/** The customer's or vendor's saved addresses: its email first, then its contacts'. */
async function addressesOnFile(ctx: Ctx, party: Prepared["party"]): Promise<string[]> {
  if (!party.id) return [];
  const table = party.type === "customer" ? customers : vendors;
  const [row] = await ctx.tx
    .select({ email: table.email, contacts: table.contacts })
    .from(table)
    .where(and(eq(table.id, party.id), eq(table.organizationId, ctx.actor.organizationId)));
  if (!row) return [];
  const contacts = (row.contacts as Array<{ email?: string }> | null) ?? [];
  const all = [row.email, ...contacts.map((c) => c.email)].filter((e): e is string => Boolean(e?.trim())).map((e) => e.trim());
  return [...new Map(all.map((e) => [e.toLowerCase(), e])).values()];
}

/** What sending would use: recipients, subject, and message, for a person to review first. */
export async function emailDraft(ctx: Ctx, input: SendEmailInput) {
  requirePermission(ctx.actor, "read", "viewer", "preview emails");
  const f = SendEmailSchema.parse(input);
  const p = await prepare(ctx, f, today());
  const s = await loadSettings(ctx);
  const vars: TemplateVars = { ...p.vars, name: p.party.name, company: s.company };
  const t = templateFor(s.templates, p.template);
  const onFile = await addressesOnFile(ctx, p.party);
  return {
    to: onFile.slice(0, 1),
    onFile,
    subject: fill(t.subject, vars),
    message: fill(t.body, vars),
    replyTo: s.effectiveReplyTo,
    configured: emailConfigured(),
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SentEmail = typeof emailMessages.$inferSelect;

/** Email a document (with its PDF) or a payment reminder. A failed send is logged and returned with status "failed". */
export async function sendDocumentEmail(ctx: Ctx, input: SendEmailInput, opts: { asOf?: string } = {}): Promise<SentEmail> {
  requirePermission(ctx.actor, "write", "bookkeeper", "email customers and vendors");
  const f = SendEmailSchema.parse(input);
  const asOf = opts.asOf ?? today();
  const p = await prepare(ctx, f, asOf);
  if (!emailConfigured()) throw new AppError("invalid_state", "Email isn't set up for this app yet (RESEND_API_KEY and EMAIL_FROM).");

  const onFile = await addressesOnFile(ctx, p.party);
  const to = f.to?.length ? f.to : onFile.slice(0, 1);
  const cc = f.cc ?? [];
  if (to.length === 0) {
    throw new AppError("invalid_state", `There's no email address on file for ${p.party.name}. Add one to the ${p.party.type}, or type one in.`);
  }
  if (ctx.actor.kind !== "user") {
    const known = new Set(onFile.map((e) => e.toLowerCase()));
    const off = [...to, ...cc].filter((a) => !known.has(a.toLowerCase()));
    if (off.length > 0) {
      throw new AppError("forbidden", `Agents can only email addresses saved on the ${p.party.type}; ${off.join(", ")} isn't one. Ask a person, or add it to the ${p.party.type} first.`);
    }
  }

  const s = await loadSettings(ctx);
  const vars: TemplateVars = { ...p.vars, name: p.party.name, company: s.company };
  const t = templateFor(s.templates, p.template);
  const subject = fill(f.subject ?? t.subject, vars);
  const body = fill(f.message ?? t.body, vars);
  const pdf = await p.attachment();

  const result = await sendEmail({
    to,
    cc,
    bcc: s.copyTo ? [s.copyTo] : [],
    fromName: s.company,
    replyTo: s.effectiveReplyTo ?? undefined,
    subject,
    text: body,
    html: emailHtml(s.company, body),
    attachments: [{ filename: pdf.fileName, content: pdf.bytes }],
  });

  const [row] = await ctx.tx
    .insert(emailMessages)
    .values({
      organizationId: ctx.actor.organizationId,
      documentType: f.documentType,
      documentId: f.documentId,
      kind: f.reminder ? "reminder" : "document",
      reminderOffset: p.daysLate ?? null,
      partyId: p.party.id,
      to,
      cc,
      subject,
      body,
      attachmentName: pdf.fileName,
      status: result.sent ? "sent" : "failed",
      providerId: result.sent ? result.id : null,
      error: result.sent ? null : result.reason,
      sentBy: ctx.actor.userId,
      sentByAgentId: ctx.actor.agentId,
    })
    .returning();
  if (result.sent && p.afterSend) await p.afterSend();
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: result.sent ? "email.sent" : "email.failed",
      entityType: f.documentType,
      entityId: f.documentId,
      metadata: { messageId: row.id, kind: row.kind, to, cc, subject, number: p.vars.number, error: row.error ?? undefined },
    },
    ctx.tx
  );
  return row;
}

/** Sent emails, newest first: one document's history, or everything. */
export async function listEmails(ctx: Ctx, input: z.input<typeof ListEmailsSchema> = {}) {
  requirePermission(ctx.actor, "read", "viewer", "list sent emails");
  const f = ListEmailsSchema.parse(input);
  const rows = await ctx.tx
    .select({
      id: emailMessages.id,
      documentType: emailMessages.documentType,
      documentId: emailMessages.documentId,
      kind: emailMessages.kind,
      to: emailMessages.to,
      cc: emailMessages.cc,
      subject: emailMessages.subject,
      attachmentName: emailMessages.attachmentName,
      status: emailMessages.status,
      error: emailMessages.error,
      sentAt: emailMessages.sentAt,
      deliveredAt: emailMessages.deliveredAt,
      openedAt: emailMessages.openedAt,
      openCount: emailMessages.openCount,
      bouncedAt: emailMessages.bouncedAt,
      sentByEmail: profiles.email,
      sentByAgent: agents.name,
    })
    .from(emailMessages)
    .leftJoin(profiles, eq(profiles.id, emailMessages.sentBy))
    .leftJoin(agents, eq(agents.id, emailMessages.sentByAgentId))
    .where(
      and(
        eq(emailMessages.organizationId, ctx.actor.organizationId),
        f.documentType ? eq(emailMessages.documentType, f.documentType) : undefined,
        f.documentId ? eq(emailMessages.documentId, f.documentId) : undefined,
        f.status ? eq(emailMessages.status, f.status) : undefined
      )
    )
    .orderBy(desc(emailMessages.sentAt))
    .limit(f.limit + 1)
    .offset(f.offset);
  return toPage(rows, f.limit, f.offset);
}

