import { runAs } from "@/lib/actor";
import { requireActor } from "@/lib/auth";
import { statementsPdf } from "@/lib/pdf/documents";
import { pdfError, pdfResponse } from "../response";

/** GET /pdf/statements?from=&to=: every listed customer's statement in one PDF. */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const actor = await requireActor();
  try {
    const file = await runAs(actor, (ctx) =>
      statementsPdf(ctx, { from: sp.get("from") || undefined, to: sp.get("to") || undefined, includeZero: sp.get("includeZero") === "1" })
    );
    if (!file) return new Response("No customers have a balance or activity in that period.", { status: 404 });
    return pdfResponse(file, sp.get("download") === "1");
  } catch (err) {
    return pdfError(err);
  }
}
