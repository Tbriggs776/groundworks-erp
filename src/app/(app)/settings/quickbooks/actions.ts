"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import { runAs } from "@/lib/actor";
import { requireActor } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { disconnectQuickBooks, recordImportFailure, runImportBatch, type ImportView } from "@/lib/qbo/service";

/** QuickBooks import actions: wrappers over src/lib/qbo/service.ts. */

export async function runQuickBooksBatch(): Promise<ActionResult<{ view: ImportView }>> {
  const actor = await requireActor("admin");
  try {
    const view = await runAs(actor, (ctx) => runImportBatch(ctx, {}));
    return { ok: true, view };
  } catch (err) {
    const e = toAppError(err);
    // The batch rolled back; mark the run so the page can offer to try again.
    await recordImportFailure(actor.organizationId, e.message);
    return { ok: false, error: e.message, code: e.code };
  }
}

export async function disconnectQbo(): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => {
    await disconnectQuickBooks(ctx);
    return { id: ctx.actor.organizationId };
  });
  if (r.ok) revalidatePath("/settings/quickbooks");
  return r;
}
