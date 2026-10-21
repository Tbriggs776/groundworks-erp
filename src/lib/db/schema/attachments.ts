import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { timestamps } from "./_shared";
import { organizations, profiles } from "./identity";

/**
 * ATTACHMENTS. A file (receipt, bill, contract, W-9, statement) kept in
 * private storage (Supabase Storage, bucket `attachments`, path
 * `<organization_id>/<id>`), never in the database. Each one belongs to at
 * most one document (`entity_type` + `entity_id`); with none, it waits in
 * the Receipts inbox. Receipts in the inbox are read by Claude: what it
 * found (vendor, date, total, …) is kept in `extracted`, to suggest a match
 * or fill in a new expense. A person or agent confirms; nothing posts on
 * reading alone.
 */

export const attachmentEntity = pgEnum("attachment_entity", [
  "bank_transaction",
  "statement_line",
  "bill",
  "bill_payment",
  "vendor_credit",
  "vendor_refund",
  "purchase_order",
  "invoice",
  "estimate",
  "customer_payment",
  "sales_receipt",
  "credit_memo",
  "refund",
  "journal",
  "inventory_adjustment",
  "reconciliation",
  "vendor",
  "customer",
]);

export const attachmentReadStatus = pgEnum("attachment_read_status", ["none", "pending", "read", "failed"]);

/** What reading a receipt found. Amounts are decimal strings; anything not on the document is null. */
export type ReceiptFields = {
  documentType: "receipt" | "invoice" | "bill" | "statement" | "other";
  vendorName: string | null;
  date: string | null;
  dueDate: string | null;
  total: string | null;
  subtotal: string | null;
  tax: string | null;
  tip: string | null;
  currency: string | null;
  paymentMethod: "card" | "cash" | "check" | "bank_transfer" | "other" | null;
  cardLast4: string | null;
  reference: string | null;
  description: string | null;
};

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityType: attachmentEntity("entity_type"),
    entityId: uuid("entity_id"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** SHA-256 of the file, hex: the same receipt uploaded twice is caught. */
    sha256: text("sha256").notNull(),
    storagePath: text("storage_path").notNull(),
    readStatus: attachmentReadStatus("read_status").notNull().default("none"),
    readError: text("read_error"),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** The model that read it. */
    readModel: text("read_model"),
    extracted: jsonb("extracted").$type<ReceiptFields>(),
    note: text("note"),
    uploadedBy: uuid("uploaded_by").references(() => profiles.id, { onDelete: "set null" }),
    uploadedByAgentId: uuid("uploaded_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("attachments_entity_idx").on(t.organizationId, t.entityType, t.entityId),
    index("attachments_sha_idx").on(t.organizationId, t.sha256),
    uniqueIndex("attachments_storage_key").on(t.storagePath),
  ]
);

export type Attachment = typeof attachments.$inferSelect;
export type AttachmentEntity = (typeof attachmentEntity.enumValues)[number];
