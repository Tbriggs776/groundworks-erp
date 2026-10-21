"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import { runAs } from "@/lib/actor";
import { requireActor } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { disconnectQuickBooks, recordImportFailure, runImportBatch, type ImportView } from "@/lib/qbo/service";
import { postTieoutEntries, refreshTieout, type Tieout } from "@/lib/qbo/tieout";

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

/** Read QuickBooks' books by month and compare them with the ledger here. */
export async function compareWithQuickBooks(): Promise<ActionResult<{ tieout: Tieout }>> {
  const r = await serviceAction("admin", async (ctx) => ({ tieout: await refreshTieout(ctx) }));
  if (r.ok) revalidatePath("/settings/quickbooks");
  return r;
}

/** Post the conversion entries for one month, or every month with differences. */
export async function postTieout(month?: string): Promise<ActionResult<{ tieout: Tieout }>> {
  const r = await serviceAction("admin", async (ctx) => ({ tieout: await postTieoutEntries(ctx, { month }) }));
  if (r.ok) revalidatePath("/settings/quickbooks");
  return r;
}
