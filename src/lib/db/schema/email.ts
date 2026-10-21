import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { agents } from "./agents";
import { organizations, profiles } from "./identity";

/**
 * EMAIL. Documents and payment reminders sent to customers and vendors,
 * with what the email service later reports (delivered, bounced, opened),
 * and each company's sender settings and templates.
 */

export const EMAIL_DOCUMENT_TYPES = ["invoice", "estimate", "sales_receipt", "credit_memo", "purchase_order", "statement"] as const;
export const emailDocumentType = pgEnum("email_document_type", EMAIL_DOCUMENT_TYPES);
export const emailKind = pgEnum("email_kind", ["document", "reminder"]);
export const emailStatus = pgEnum("email_status", ["sent", "failed", "delivered", "delayed", "bounced", "complained"]);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentType: emailDocumentType("document_type").notNull(),
    /** The document; for a statement, the customer. */
    documentId: uuid("document_id").notNull(),
    kind: emailKind("kind").notNull().default("document"),
    /** Reminders: days past the due date when sent (negative = before it). */
    reminderOffset: integer("reminder_offset"),
    /** The customer or vendor. */
    partyId: uuid("party_id"),
    to: text("to").array().notNull(),
    cc: text("cc").array().notNull().default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    attachmentName: text("attachment_name"),
    status: emailStatus("status").notNull(),
    /** The email service's id, which its delivery events refer to. */
    providerId: text("provider_id"),
    error: text("error"),
    sentBy: uuid("sent_by").references(() => profiles.id, { onDelete: "set null" }),
    sentByAgentId: uuid("sent_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("email_messages_document_idx").on(t.organizationId, t.documentType, t.documentId),
    index("email_messages_org_sent_idx").on(t.organizationId, t.sentAt),
    uniqueIndex("email_messages_provider_key").on(t.providerId),
  ]
);

export type EmailTemplateKey = (typeof EMAIL_DOCUMENT_TYPES)[number] | "reminder";
export type EmailTemplates = Partial<Record<EmailTemplateKey, { subject: string; body: string }>>;

export const emailSettings = pgTable(
  "email_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Where customers' replies go. Empty: the company profile's email. */
    replyTo: text("reply_to"),
    /** Copied (BCC) on every email the company sends, for its own records. */
    copyTo: text("copy_to"),
    remindersEnabled: boolean("reminders_enabled").notNull().default(false),
    /** Days relative to the due date: -3 is three days before, 7 is a week late. */
    reminderDays: integer("reminder_days").array().notNull().default(sql`'{-3,0,7,30}'::integer[]`),
    /** Subject and body per document type; missing keys use the defaults. */
    templates: jsonb("templates").$type<EmailTemplates>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex("email_settings_org_key").on(t.organizationId)]
);

export type EmailMessage = typeof emailMessages.$inferSelect;
export type EmailSettingsRow = typeof emailSettings.$inferSelect;
