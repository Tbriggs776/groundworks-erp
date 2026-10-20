import { runAs } from "@/lib/actor";
import { requireActor } from "@/lib/auth";
import { documentPdf, statementPdf, type PdfDocKind } from "@/lib/pdf/documents";
import { pdfError, pdfResponse } from "../../response";

/**
 * GET /pdf/<kind>/<id>: a customer-facing PDF for the active company.
 * Kinds: invoice, estimate, sales-receipt, credit-memo, and statement
 * (id = customer, ?from=&to=). Add ?download=1 to save instead of view.
 */
const KINDS: Record<string, PdfDocKind> = {
  invoice: "invoice",
  estimate: "estimate",
  "sales-receipt": "sales_receipt",
  "credit-memo": "credit_memo",
};

export async function GET(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  const sp = new URL(request.url).searchParams;
  const actor = await requireActor();
  try {
    const file =
      kind === "statement"
        ? await runAs(actor, (ctx) => statementPdf(ctx, { id, from: sp.get("from") || undefined, to: sp.get("to") || undefined }))
        : KINDS[kind]
          ? await runAs(actor, (ctx) => documentPdf(ctx, KINDS[kind], id))
          : null;
    if (!file) return new Response("Not found", { status: 404 });
    return pdfResponse(file, sp.get("download") === "1");
  } catch (err) {
    return pdfError(err);
  }
}
