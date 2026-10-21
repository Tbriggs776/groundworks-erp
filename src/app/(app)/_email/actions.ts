"use server";

import { revalidatePath } from "next/cache";
import { serviceAction } from "@/lib/action";
import * as mail from "@/lib/messaging/service";

/** Email dialog and settings → src/lib/messaging/service.ts. */
export async function emailDraftAction(input: mail.SendEmailInput) {
  return serviceAction("viewer", (ctx) => mail.emailDraft(ctx, input));
}

export async function sendEmailAction(input: mail.SendEmailInput, path: string) {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ email: await mail.sendDocumentEmail(ctx, input) }));
  if (r.ok) revalidatePath(path);
  return r;
}

export async function updateEmailSettingsAction(input: {
  replyTo?: string | null;
  copyTo?: string | null;
  remindersEnabled?: boolean;
  reminderDays?: number[];
  templates?: Record<string, { subject: string; body: string } | null>;
}) {
  const r = await serviceAction("admin", async (ctx) => ({ settings: await mail.updateEmailSettings(ctx, input) }));
  if (r.ok) revalidatePath("/settings/email");
  return r;
}
