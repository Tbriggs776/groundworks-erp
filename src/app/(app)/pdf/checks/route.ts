import { runAs } from "@/lib/actor";
import { requireActor } from "@/lib/auth";
import { CHECK_KINDS, type CheckKind } from "@/lib/ap/checks";
import { checksPdf } from "@/lib/pdf/documents";
import { pdfError, pdfResponse } from "../response";

/**
 * GET /pdf/checks?items=bill_payment:<id>,check:<id>: the listed checks on
 * voucher stock, one per page, in that order. Add ?download=1 to save.
 */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const refs = (sp.get("items") ?? "")
    .split(",")
    .filter(Boolean)
    .map((item) => {
      const [kind, id] = item.split(":");
      return { kind: kind as CheckKind, id };
    });
  if (refs.length === 0 || refs.length > 100 || refs.some((r) => !CHECK_KINDS.includes(r.kind) || !r.id)) {
    return new Response("List 1 to 100 checks as items=kind:id,…", { status: 400 });
  }
  const actor = await requireActor();
  try {
    const file = await runAs(actor, (ctx) => checksPdf(ctx, refs));
    return pdfResponse(file, sp.get("download") === "1");
  } catch (err) {
    return pdfError(err);
  }
}
