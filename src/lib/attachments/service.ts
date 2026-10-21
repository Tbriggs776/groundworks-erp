import { createHash, randomUUID } from "node:crypto";
import { addDays, format, parseISO, subDays } from "date-fns";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  accounts,
  apBills,
  apPayments,
  arInvoices,
  arPayments,
  attachmentEntity,
  attachments,
  bankFeedAccounts,
  bankStatementLines,
  bankTransactionLines,
  bankTransactions,
  creditMemos,
  customers,
  estimates,
  glJournals,
  inventoryAdjustments,
  purchaseOrders,
  reconciliations,
  refundReceipts,
  salesReceipts,
  vendorCredits,
  vendorRefunds,
  vendors,
  type Attachment,
  type AttachmentEntity,
  type ReceiptFields,
} from "@/lib/db/schema";
import { auditFields, requirePermission, runAs, systemActor, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { createExpense, type BankTransactionDetail } from "@/lib/banking/transactions";
import { db } from "@/lib/db/client";
import { AppError, notFound } from "@/lib/errors";
import { putFile, getFile, removeFile } from "@/lib/files/storage";
import { money } from "@/lib/money";
import type { ReviewNotice } from "@/lib/review-policy";
import { flag, id, isoDate, optionalText, pagination, toPage, type Page } from "@/lib/schemas";
import { READABLE_TYPES, readReceipt, readerConfigured } from "./reader";

/**
 * ATTACHMENTS AND RECEIPTS. Files sit in private storage (src/lib/files);
 * each belongs to one document, or waits in the Receipts inbox. Receipts in
 * the inbox are read by Claude (reader.ts), then matched to a bank line, an
 * expense, or a bill, or turned into a new expense. When a bank line in For
 * review is added or matched, its receipts move to what it became.
 */

export const MAX_BYTES = 4 * 1024 * 1024;

type DocTable = PgTable & { id: AnyPgColumn; organizationId: AnyPgColumn };
type Entity = { table: DocTable; label: string; href: (id: string) => string; journal?: AnyPgColumn };

/** Every kind of document a file can belong to, where it lives, and its page. */
export const ENTITIES: Record<AttachmentEntity, Entity> = {
  bank_transaction: { table: bankTransactions, label: "Bank transaction", href: (i) => `/banking/transactions/${i}`, journal: bankTransactions.glJournalId },
  statement_line: { table: bankStatementLines, label: "Bank line in For review", href: () => "/banking/review" },
  bill: { table: apBills, label: "Bill", href: (i) => `/ap/bills/${i}`, journal: apBills.glJournalId },
  bill_payment: { table: apPayments, label: "Bill payment", href: (i) => `/ap/payments/${i}`, journal: apPayments.glJournalId },
  vendor_credit: { table: vendorCredits, label: "Vendor credit", href: (i) => `/ap/vendor-credits/${i}`, journal: vendorCredits.glJournalId },
  vendor_refund: { table: vendorRefunds, label: "Vendor refund", href: (i) => `/ap/vendor-refunds/${i}`, journal: vendorRefunds.glJournalId },
  purchase_order: { table: purchaseOrders, label: "Purchase order", href: (i) => `/ap/purchase-orders/${i}` },
  invoice: { table: arInvoices, label: "Invoice", href: (i) => `/ar/invoices/${i}`, journal: arInvoices.glJournalId },
  estimate: { table: estimates, label: "Estimate", href: (i) => `/ar/estimates/${i}` },
  customer_payment: { table: arPayments, label: "Payment received", href: (i) => `/ar/payments/${i}`, journal: arPayments.glJournalId },
  sales_receipt: { table: salesReceipts, label: "Sales receipt", href: (i) => `/ar/sales-receipts/${i}`, journal: salesReceipts.glJournalId },
  credit_memo: { table: creditMemos, label: "Credit memo", href: (i) => `/ar/credit-memos/${i}`, journal: creditMemos.glJournalId },
  refund: { table: refundReceipts, label: "Refund", href: (i) => `/ar/refunds/${i}`, journal: refundReceipts.glJournalId },
  journal: { table: glJournals, label: "Journal entry", href: (i) => `/gl/${i}` },
  inventory_adjustment: { table: inventoryAdjustments, label: "Inventory adjustment", href: (i) => `/items/adjustments/${i}`, journal: inventoryAdjustments.glJournalId },
  reconciliation: { table: reconciliations, label: "Reconciliation", href: (i) => `/banking/reconcile/${i}` },
  vendor: { table: vendors, label: "Vendor", href: () => "/vendors" },
  customer: { table: customers, label: "Customer", href: () => "/customers" },
};

const entityType = z.enum(attachmentEntity.enumValues);

// ---------------------------------------------------------------------------
// Files: what's allowed, by what the bytes are (never by the name the browser sent)
// ---------------------------------------------------------------------------

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

function sniff(bytes: Buffer, fileName: string): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return null;
  }
  if ((ext === "csv" || ext === "txt") && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return ext === "csv" ? "text/csv" : "text/plain";
    } catch {
      return null;
    }
  }
  return null;
}

const cleanName = (name: string) =>
  name
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 200) || "file";

/** Shown inline in the browser (the rest download). */
export const INLINE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"]);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type AttachmentView = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  entityType: AttachmentEntity | null;
  entityId: string | null;
  entityLabel: string | null;
  entityHref: string | null;
  readStatus: Attachment["readStatus"];
  readError: string | null;
  extracted: ReceiptFields | null;
  note: string | null;
  uploadedAt: Date;
  uploadedByAgent: boolean;
};

const view = (a: Attachment): AttachmentView => ({
  id: a.id,
  fileName: a.fileName,
  contentType: a.contentType,
  sizeBytes: a.sizeBytes,
  url: `/files/${a.id}`,
  entityType: a.entityType,
  entityId: a.entityId,
  entityLabel: a.entityType ? ENTITIES[a.entityType].label : null,
  entityHref: a.entityType && a.entityId ? ENTITIES[a.entityType].href(a.entityId) : null,
  readStatus: a.readStatus,
  readError: a.readError,
  extracted: a.extracted ?? null,
  note: a.note,
  uploadedAt: a.createdAt,
  uploadedByAgent: Boolean(a.uploadedByAgentId),
});

async function load(ctx: Ctx, attachmentId: string, lock = false): Promise<Attachment> {
  const q = ctx.tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.organizationId, ctx.actor.organizationId)));
  const [a] = lock ? await q.for("update") : await q;
  if (!a) throw notFound("Attachment");
  return a;
}

/** The document must be this company's. */
async function requireEntity(ctx: Ctx, type: AttachmentEntity, entityId: string): Promise<void> {
  const t = ENTITIES[type].table;
  const [row] = await ctx.tx
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, entityId), eq(t.organizationId, ctx.actor.organizationId)));
  if (!row) throw notFound(ENTITIES[type].label);
}

const audit = (ctx: Ctx, event: string, a: Attachment, metadata: Record<string, unknown> = {}) =>
  writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event,
      entityType: "attachment",
      entityId: a.id,
      metadata: { fileName: a.fileName, sha256: a.sha256, entityType: a.entityType, entityId: a.entityId, ...metadata },
    },
    ctx.tx
  );

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export const UploadAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(255).describe("The file's name, e.g. receipt.jpg."),
  contentBase64: z
    .string()
    .min(4)
    .max(Math.ceil((MAX_BYTES * 4) / 3) + 8)
    .describe("The file, base64. PDF, JPEG, PNG, WebP, GIF, CSV, TXT, XLSX, or DOCX, up to 4 MB."),
  entityType: entityType.optional().describe("Attach to this kind of document; leave out (with entityId) to put a receipt in the Receipts inbox."),
  entityId: id.optional(),
  note: optionalText(500),
  read: flag.optional().describe("Inbox receipts only: read it with Claude now (default true)."),
});
export type UploadAttachmentInput = z.input<typeof UploadAttachmentSchema>;

export type UploadResult = AttachmentView & {
  /** The same file is already here (by content). */
  duplicateOf: { id: string; entityLabel: string | null; entityHref: string | null } | null;
};

/** Keep a file: on a document, or in the Receipts inbox (where it's read when it's a receipt). */
export async function uploadAttachment(ctx: Ctx, input: UploadAttachmentInput): Promise<UploadResult> {
  const d = UploadAttachmentSchema.parse(input);
  const bytes = Buffer.from(d.contentBase64, "base64");
  const stored = await storeAttachment(ctx, { fileName: d.fileName, bytes, entityType: d.entityType, entityId: d.entityId, note: d.note ?? undefined });
  if (stored.readStatus === "pending" && d.read !== false) {
    const read = await readAttachment(ctx, { id: stored.id });
    return { ...read, duplicateOf: stored.duplicateOf };
  }
  return stored;
}

export async function storeAttachment(
  ctx: Ctx,
  input: { fileName: string; bytes: Buffer; entityType?: AttachmentEntity; entityId?: string; note?: string }
): Promise<UploadResult> {
  requirePermission(ctx.actor, "write", "bookkeeper", "attach files");
  const org = ctx.actor.organizationId;
  if (Boolean(input.entityType) !== Boolean(input.entityId)) throw new AppError("invalid_input", "Give entityType and entityId together.");
  if (input.bytes.length === 0) throw new AppError("invalid_input", "That file is empty.");
  if (input.bytes.length > MAX_BYTES) throw new AppError("invalid_input", "Files can be up to 4 MB. Take a smaller photo or split the PDF.");
  const fileName = cleanName(input.fileName);
  const contentType = sniff(input.bytes, fileName);
  if (!contentType) throw new AppError("invalid_input", "That kind of file can't be attached. Use a PDF, an image (JPEG, PNG, WebP, GIF), or a CSV, TXT, XLSX, or DOCX file.");
  if (input.entityType && input.entityId) await requireEntity(ctx, input.entityType, input.entityId);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const [dupe] = await ctx.tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.organizationId, org), eq(attachments.sha256, sha256)))
    .limit(1);
  const attachmentId = randomUUID();
  const inbox = !input.entityType;
  const [a] = await ctx.tx
    .insert(attachments)
    .values({
      id: attachmentId,
      organizationId: org,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      fileName,
      contentType,
      sizeBytes: input.bytes.length,
      sha256,
      storagePath: `${org}/${attachmentId}`,
      readStatus: inbox && READABLE_TYPES.has(contentType) && readerConfigured() ? "pending" : "none",
      note: input.note ?? null,
      uploadedBy: ctx.actor.userId,
      uploadedByAgentId: ctx.actor.agentId,
    })
    .returning();
  await putFile(a.storagePath, input.bytes, contentType);
  await audit(ctx, "attachment.uploaded", a, { sizeBytes: a.sizeBytes, contentType, duplicateOf: dupe?.id ?? null });
  return {
    ...view(a),
    duplicateOf: dupe ? { id: dupe.id, entityLabel: view(dupe).entityLabel, entityHref: view(dupe).entityHref } : null,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Read a receipt with Claude and keep what it found. A failure is kept too (and can be retried). */
export async function readAttachment(ctx: Ctx, input: { id: string }): Promise<AttachmentView> {
  requirePermission(ctx.actor, "write", "bookkeeper", "read receipts");
  const { id: attachmentId } = z.object({ id }).parse(input);
  const a = await load(ctx, attachmentId, true);
  if (!READABLE_TYPES.has(a.contentType)) throw new AppError("invalid_input", "Only PDFs and images can be read.");
  if (!readerConfigured()) throw new AppError("invalid_state", "Receipt reading isn't set up: ANTHROPIC_API_KEY is missing.");
  let values: Partial<typeof attachments.$inferInsert>;
  try {
    const { fields, model } = await readReceipt(await getFile(a.storagePath), a.contentType);
    values = { readStatus: "read", extracted: fields, readModel: model, readError: null };
  } catch (e) {
    if (e instanceof AppError && e.code === "invalid_state") throw e;
    values = { readStatus: "failed", readError: e instanceof Error ? e.message : String(e) };
  }
  const [updated] = await ctx.tx
    .update(attachments)
    .set({ ...values, readAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(attachments.id, a.id))
    .returning();
  await audit(ctx, "attachment.read", updated, { status: updated.readStatus, model: updated.readModel, error: updated.readError });
  return view(updated);
}

// ---------------------------------------------------------------------------
// Lists and one file
// ---------------------------------------------------------------------------

export const ListAttachmentsSchema = z.object({
  entityType: entityType.optional(),
  entityId: id.optional(),
  inbox: flag.optional().describe("Only the Receipts inbox (files not on any document)."),
  ...pagination,
});

export async function listAttachments(ctx: Ctx, input: z.input<typeof ListAttachmentsSchema> = {}): Promise<Page<AttachmentView>> {
  requirePermission(ctx.actor, "read", "viewer", "view attachments");
  const d = ListAttachmentsSchema.parse(input);
  const where = [eq(attachments.organizationId, ctx.actor.organizationId)];
  if (d.inbox) where.push(isNull(attachments.entityType));
  if (d.entityType) where.push(eq(attachments.entityType, d.entityType));
  if (d.entityId) where.push(eq(attachments.entityId, d.entityId));
  const rows = await ctx.tx
    .select()
    .from(attachments)
    .where(and(...where))
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
    .limit(d.limit + 1)
    .offset(d.offset);
  return toPage(rows.map(view), d.limit, d.offset);
}

/** Files on one document, oldest first (for its page). */
export async function attachmentsFor(ctx: Ctx, type: AttachmentEntity, entityId: string): Promise<AttachmentView[]> {
  requirePermission(ctx.actor, "read", "viewer", "view attachments");
  const rows = await ctx.tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.organizationId, ctx.actor.organizationId), eq(attachments.entityType, type), eq(attachments.entityId, entityId)))
    .orderBy(asc(attachments.createdAt));
  return rows.map(view);
}

/** How many files each of these documents has (paperclips in lists). */
export async function attachmentCounts(ctx: Ctx, type: AttachmentEntity, entityIds: string[]): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ entityId: attachments.entityId, n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(and(eq(attachments.organizationId, ctx.actor.organizationId), eq(attachments.entityType, type), inArray(attachments.entityId, entityIds)))
    .groupBy(attachments.entityId);
  return new Map(rows.map((r) => [r.entityId!, r.n]));
}

export type MatchSuggestion = {
  kind: "statement_line" | "bank_transaction" | "bill";
  id: string;
  date: string;
  amount: string;
  description: string;
  account: string | null;
  href: string;
};

export type ReceiptSuggestions = {
  matches: MatchSuggestion[];
  vendor: { id: string; name: string } | null;
  bankAccount: { id: string; code: string; name: string } | null;
  categoryAccount: { id: string; code: string; name: string } | null;
};

export type AttachmentDetail = AttachmentView & { suggestions: ReceiptSuggestions | null };

export async function getAttachment(ctx: Ctx, input: { id: string }): Promise<AttachmentDetail> {
  requirePermission(ctx.actor, "read", "viewer", "view attachments");
  const { id: attachmentId } = z.object({ id }).parse(input);
  const a = await load(ctx, attachmentId);
  return { ...view(a), suggestions: !a.entityType && a.extracted ? await suggest(ctx, a.extracted) : null };
}

/** The file itself, for the /files route and the API. */
export async function openAttachment(ctx: Ctx, attachmentId: string): Promise<{ fileName: string; contentType: string; bytes: Buffer }> {
  requirePermission(ctx.actor, "read", "viewer", "view attachments");
  const a = await load(ctx, z.uuid().parse(attachmentId));
  return { fileName: a.fileName, contentType: a.contentType, bytes: await getFile(a.storagePath) };
}

export async function downloadAttachment(ctx: Ctx, input: { id: string }): Promise<{ fileName: string; contentType: string; contentBase64: string }> {
  const f = await openAttachment(ctx, z.object({ id }).parse(input).id);
  return { fileName: f.fileName, contentType: f.contentType, contentBase64: f.bytes.toString("base64") };
}

// ---------------------------------------------------------------------------
// Suggestions: where a read receipt probably belongs
// ---------------------------------------------------------------------------

const near = (d: string, before: number, after: number) => ({
  from: format(subDays(parseISO(d), before), "yyyy-MM-dd"),
  to: format(addDays(parseISO(d), after), "yyyy-MM-dd"),
});
const distance = (a: string, b: string) => Math.abs(parseISO(a).getTime() - parseISO(b).getTime());

async function suggest(ctx: Ctx, f: ReceiptFields): Promise<ReceiptSuggestions> {
  const org = ctx.actor.organizationId;
  const out: ReceiptSuggestions = { matches: [], vendor: null, bankAccount: null, categoryAccount: null };

  if (f.vendorName) {
    const name = f.vendorName.toLowerCase();
    const first = name.split(/\s+/)[0]?.replace(/[^a-z0-9&'-]/g, "") ?? "";
    const candidates = await ctx.tx
      .select({ id: vendors.id, name: vendors.name, displayName: vendors.displayName })
      .from(vendors)
      .where(
        and(
          eq(vendors.organizationId, org),
          isNull(vendors.deletedAt),
          first.length >= 3 ? or(ilike(vendors.name, `${first}%`), ilike(vendors.displayName, `${first}%`)) : sql`false`
        )
      )
      .limit(10);
    const exact = candidates.find((v) => v.name.toLowerCase() === name || v.displayName?.toLowerCase() === name);
    const pick = exact ?? (candidates.length === 1 ? candidates[0] : null);
    if (pick) out.vendor = { id: pick.id, name: pick.displayName ?? pick.name };
  }

  // Where it was paid from: a bank feed account whose last four digits match the card.
  if (f.cardLast4) {
    const [acct] = await ctx.tx
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(bankFeedAccounts)
      .innerJoin(accounts, eq(accounts.id, bankFeedAccounts.accountId))
      .where(and(eq(bankFeedAccounts.organizationId, org), eq(bankFeedAccounts.mask, f.cardLast4)))
      .limit(1);
    if (acct) out.bankAccount = acct;
  }

  // The category this vendor's last expense used.
  if (out.vendor) {
    const [last] = await ctx.tx
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(bankTransactionLines)
      .innerJoin(bankTransactions, eq(bankTransactions.id, bankTransactionLines.transactionId))
      .innerJoin(accounts, eq(accounts.id, bankTransactionLines.accountId))
      .where(and(eq(bankTransactions.organizationId, org), eq(bankTransactions.vendorId, out.vendor.id), ne(bankTransactions.status, "voided")))
      .orderBy(desc(bankTransactions.txnDate))
      .limit(1);
    if (last) out.categoryAccount = last;
  }

  if (!f.total || !f.date) return out;
  const total = money(f.total).toFixed(4);
  const out4 = money(f.total).neg().toFixed(4);
  const w = near(f.date, 3, 10);
  const lines = await ctx.tx
    .select({ l: bankStatementLines, account: accounts.name })
    .from(bankStatementLines)
    .innerJoin(accounts, eq(accounts.id, bankStatementLines.accountId))
    .where(
      and(
        eq(bankStatementLines.organizationId, org),
        eq(bankStatementLines.status, "for_review"),
        eq(bankStatementLines.amount, out4),
        gte(bankStatementLines.postedDate, w.from),
        lte(bankStatementLines.postedDate, w.to)
      )
    )
    .limit(10);
  for (const { l, account } of lines) {
    out.matches.push({ kind: "statement_line", id: l.id, date: l.postedDate, amount: l.amount, description: l.payee ?? l.description, account, href: `/banking/review?account=${l.accountId}` });
  }
  const t = near(f.date, 7, 7);
  const attached = ctx.tx
    .select({ id: attachments.entityId })
    .from(attachments)
    .where(and(eq(attachments.organizationId, org), eq(attachments.entityType, "bank_transaction")));
  const txns = await ctx.tx
    .select({ t: bankTransactions, account: accounts.name })
    .from(bankTransactions)
    .innerJoin(accounts, eq(accounts.id, bankTransactions.bankAccountId))
    .where(
      and(
        eq(bankTransactions.organizationId, org),
        inArray(bankTransactions.type, ["expense", "check"]),
        ne(bankTransactions.status, "voided"),
        eq(bankTransactions.totalAmount, total),
        gte(bankTransactions.txnDate, t.from),
        lte(bankTransactions.txnDate, t.to),
        notInArray(bankTransactions.id, attached)
      )
    )
    .limit(10);
  for (const { t: x, account } of txns) {
    out.matches.push({ kind: "bank_transaction", id: x.id, date: x.txnDate, amount: x.totalAmount, description: x.payeeName ?? x.memo ?? x.txnNumber, account, href: `/banking/transactions/${x.id}` });
  }
  const b = near(f.date, 10, 10);
  const bills = await ctx.tx
    .select({ b: apBills, vendor: vendors.name })
    .from(apBills)
    .innerJoin(vendors, eq(vendors.id, apBills.vendorId))
    .where(
      and(eq(apBills.organizationId, org), ne(apBills.status, "voided"), eq(apBills.totalAmount, total), gte(apBills.billDate, b.from), lte(apBills.billDate, b.to))
    )
    .limit(10);
  for (const { b: x, vendor } of bills) {
    out.matches.push({ kind: "bill", id: x.id, date: x.billDate, amount: x.totalAmount, description: `${vendor} · ${x.billNumber}`, account: null, href: `/ap/bills/${x.id}` });
  }
  out.matches.sort((p, q) => distance(p.date, f.date!) - distance(q.date, f.date!));
  out.matches = out.matches.slice(0, 6);
  return out;
}

// ---------------------------------------------------------------------------
// Link, move, delete
// ---------------------------------------------------------------------------

export const LinkAttachmentSchema = z.object({
  id,
  entityType: entityType.nullable().describe("The kind of document; null (with entityId null) moves the file back to the Receipts inbox."),
  entityId: id.nullable(),
});

export async function linkAttachment(ctx: Ctx, input: z.input<typeof LinkAttachmentSchema>): Promise<AttachmentView> {
  requirePermission(ctx.actor, "write", "bookkeeper", "attach files");
  const d = LinkAttachmentSchema.parse(input);
  if (Boolean(d.entityType) !== Boolean(d.entityId)) throw new AppError("invalid_input", "Give entityType and entityId together (both null for the inbox).");
  const a = await load(ctx, d.id, true);
  if (d.entityType && d.entityId) await requireEntity(ctx, d.entityType, d.entityId);
  const [updated] = await ctx.tx
    .update(attachments)
    .set({ entityType: d.entityType, entityId: d.entityId, updatedAt: sql`now()` })
    .where(eq(attachments.id, a.id))
    .returning();
  await audit(ctx, d.entityType ? "attachment.linked" : "attachment.unlinked", updated, { from: { entityType: a.entityType, entityId: a.entityId } });
  return view(updated);
}

/** Move every file on one document to another (or to the inbox). For bank lines as they're reviewed. */
export async function moveAttachments(
  ctx: Ctx,
  from: { type: AttachmentEntity; id: string },
  to: { type: AttachmentEntity; id: string } | null
): Promise<number> {
  const moved = await ctx.tx
    .update(attachments)
    .set({ entityType: to?.type ?? null, entityId: to?.id ?? null, updatedAt: sql`now()` })
    .where(and(eq(attachments.organizationId, ctx.actor.organizationId), eq(attachments.entityType, from.type), eq(attachments.entityId, from.id)))
    .returning();
  for (const a of moved) await audit(ctx, to ? "attachment.linked" : "attachment.unlinked", a, { from: { entityType: from.type, entityId: from.id } });
  return moved.length;
}

/** The document a ledger journal was posted for (or the journal itself, for a journal entry). */
export async function documentForJournal(ctx: Ctx, journalId: string): Promise<{ type: AttachmentEntity; id: string }> {
  for (const [type, e] of Object.entries(ENTITIES) as Array<[AttachmentEntity, Entity]>) {
    if (!e.journal) continue;
    const [row] = await ctx.tx
      .select({ id: e.table.id })
      .from(e.table)
      .where(and(eq(e.table.organizationId, ctx.actor.organizationId), eq(e.journal, journalId)))
      .limit(1);
    if (row) return { type, id: row.id as string };
  }
  return { type: "journal", id: journalId };
}

export async function deleteAttachment(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "delete attachments");
  const { id: attachmentId } = z.object({ id }).parse(input);
  const a = await load(ctx, attachmentId, true);
  if (ctx.actor.kind === "agent" && a.uploadedByAgentId !== ctx.actor.agentId) {
    throw new AppError("forbidden", "Agents can delete only files they uploaded.");
  }
  await ctx.tx.delete(attachments).where(eq(attachments.id, a.id));
  await audit(ctx, "attachment.deleted", a, { sizeBytes: a.sizeBytes });
  await removeFile(a.storagePath);
  return { id: a.id };
}

// ---------------------------------------------------------------------------
// A new expense from a receipt
// ---------------------------------------------------------------------------

export const ExpenseFromReceiptSchema = z.object({
  id,
  bankAccountId: id.describe("Bank or card account it was paid from."),
  categoryAccountId: id.describe("Expense category."),
  vendorId: id.optional(),
  payeeName: optionalText(200).describe("When there's no vendor record: the payee as printed."),
  txnDate: isoDate.optional().describe("Default: the receipt's date."),
  amount: z.string().optional().describe("Default: the receipt's total."),
  memo: optionalText(500),
  post: z.boolean().optional().describe("Post to the ledger in the same call."),
});

/** Record a receipt that isn't in the books yet as an expense, with the receipt attached. */
export async function createExpenseFromReceipt(
  ctx: Ctx,
  input: z.input<typeof ExpenseFromReceiptSchema>
): Promise<{ transaction: BankTransactionDetail & Partial<ReviewNotice>; attachment: AttachmentView }> {
  requirePermission(ctx.actor, "write", "bookkeeper", "record expenses from receipts");
  const d = ExpenseFromReceiptSchema.parse(input);
  const a = await load(ctx, d.id, true);
  if (a.entityType) throw new AppError("invalid_state", `This file is already on a ${ENTITIES[a.entityType].label.toLowerCase()}.`);
  const f = a.extracted;
  const txnDate = d.txnDate ?? f?.date;
  const total = d.amount ?? f?.total;
  if (!txnDate) throw new AppError("invalid_input", "Give txnDate: the receipt's date wasn't read.");
  if (!total) throw new AppError("invalid_input", "Give amount: the receipt's total wasn't read.");
  const transaction = await createExpense(ctx, {
    type: f?.paymentMethod === "check" ? "check" : "expense",
    txnDate,
    bankAccountId: d.bankAccountId,
    vendorId: d.vendorId,
    payeeName: d.vendorId ? undefined : (d.payeeName ?? f?.vendorName ?? undefined),
    reference: f?.paymentMethod === "check" ? undefined : (f?.reference ?? undefined),
    memo: d.memo ?? f?.description ?? undefined,
    lines: [{ accountId: d.categoryAccountId, amount: total, description: f?.description ?? undefined }],
    post: d.post,
  });
  const attachment = await linkAttachment(ctx, { id: a.id, entityType: "bank_transaction", entityId: transaction.id });
  return { transaction, attachment };
}

// ---------------------------------------------------------------------------
// Daily upkeep
// ---------------------------------------------------------------------------

/**
 * Files whose document was deleted (a draft, or a bank line the bank took
 * back) go back to the inbox, and receipts whose reading never ran (the
 * server stopped first) are read.
 */
export async function runAttachmentUpkeepForOrg(organizationId: string): Promise<{ returned: number; read: number; failed: number }> {
  let returned = 0;
  for (const [type, e] of Object.entries(ENTITIES) as Array<[AttachmentEntity, Entity]>) {
    const t = e.table;
    const r = await db
      .update(attachments)
      .set({ entityType: null, entityId: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(attachments.organizationId, organizationId),
          eq(attachments.entityType, type),
          sql`NOT EXISTS (SELECT 1 FROM ${t} WHERE ${t.id} = ${attachments.entityId})`
        )
      )
      .returning({ id: attachments.id });
    returned += r.length;
  }
  let read = 0;
  let failed = 0;
  if (readerConfigured()) {
    const stale = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.organizationId, organizationId), eq(attachments.readStatus, "pending"), lte(attachments.createdAt, sql`now() - interval '15 minutes'`)))
      .limit(50);
    const actor = systemActor(organizationId);
    for (const s of stale) {
      const v = await runAs(actor, (ctx) => readAttachment(ctx, { id: s.id })).catch(() => null);
      if (v?.readStatus === "read") read++;
      else failed++;
    }
  }
  return { returned, read, failed };
}
