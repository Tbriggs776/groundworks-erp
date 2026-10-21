"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { serviceAction, type ActionResult } from "@/lib/action";
import { runAs } from "@/lib/actor";
import * as files from "@/lib/attachments/service";
import { requireActor } from "@/lib/auth";
import { attachmentEntity, type AttachmentEntity } from "@/lib/db/schema";

/** Attachment actions: wrappers over src/lib/attachments/service.ts. */

const entityOf = (v: FormDataEntryValue | null): AttachmentEntity | undefined =>
  typeof v === "string" && (attachmentEntity.enumValues as readonly string[]).includes(v) ? (v as AttachmentEntity) : undefined;
const pathOf = (v: FormDataEntryValue | string | null) => (typeof v === "string" && v.startsWith("/") ? v : null);

/** One file per call (requests are capped at a few MB). Inbox receipts are read after the response. */
export async function uploadFile(form: FormData): Promise<ActionResult<{ file: files.UploadResult }>> {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a file.", code: "invalid_input" };
  const entityType = entityOf(form.get("entityType"));
  const entityId = typeof form.get("entityId") === "string" && form.get("entityId") ? String(form.get("entityId")) : undefined;
  const bytes = Buffer.from(await file.arrayBuffer());
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    file: await files.storeAttachment(ctx, { fileName: file.name, bytes, entityType, entityId }),
  }));
  if (r.ok && r.file.readStatus === "pending") {
    const actor = await requireActor("bookkeeper");
    const attachmentId = r.file.id;
    after(() => runAs(actor, (ctx) => files.readAttachment(ctx, { id: attachmentId })).catch((e) => console.warn("[receipts] read failed:", e instanceof Error ? e.message : e)));
  }
  const path = pathOf(form.get("path"));
  if (r.ok && path) revalidatePath(path);
  return r;
}

export async function readFile(id: string, path?: string): Promise<ActionResult<{ file: files.AttachmentView }>> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ file: await files.readAttachment(ctx, { id }) }));
  if (r.ok && pathOf(path ?? null)) revalidatePath(path!);
  return r;
}

export async function linkFile(id: string, entityType: AttachmentEntity | null, entityId: string | null, path?: string): Promise<ActionResult<{ file: files.AttachmentView }>> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ file: await files.linkAttachment(ctx, { id, entityType, entityId }) }));
  if (r.ok && pathOf(path ?? null)) revalidatePath(path!);
  return r;
}

export async function deleteFile(id: string, path?: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => files.deleteAttachment(ctx, { id }));
  if (r.ok && pathOf(path ?? null)) revalidatePath(path!);
  return r;
}

export async function expenseFromReceipt(input: {
  id: string;
  bankAccountId: string;
  categoryAccountId: string;
  vendorId?: string;
  payeeName?: string;
  txnDate?: string;
  amount?: string;
  memo?: string;
}): Promise<ActionResult<{ id: string; transactionId: string; review?: { required: true; reason: string } }>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const out = await files.createExpenseFromReceipt(ctx, { ...input, post: true });
    return { id: out.attachment.id, transactionId: out.transaction.id, ...(out.transaction.review ? { review: out.transaction.review } : {}) };
  });
  if (r.ok) {
    revalidatePath("/banking/receipts");
    revalidatePath("/banking/transactions");
  }
  return r;
}
