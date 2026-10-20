import { runAs } from "@/lib/actor";
import { form1099Export, FORM_1099_BOXES } from "@/lib/ap/form-1099";
import { requireActor } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { csvResponse, toCsv } from "@/lib/ui/csv";

/**
 * GET /reports/1099/export?year=&threshold=: reportable vendors with full
 * TINs, one row per vendor, for an e-file service. Accountant and up; the
 * export is audited.
 */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const actor = await requireActor("accountant");
  try {
    const r = await runAs(actor, (ctx) =>
      form1099Export(ctx, { year: sp.get("year") ? Number(sp.get("year")) : undefined, threshold: sp.get("threshold") || undefined })
    );
    const body = toCsv(
      ["vendor", "tin", "address", ...FORM_1099_BOXES, "total", "w9_on_file", "issues"],
      r.rows.map((v) => [v.name, v.tin, v.addressLines.join(", "), ...FORM_1099_BOXES.map((b) => v.boxes[b]), v.total, v.w9OnFile ? "yes" : "no", v.issues.join("; ")])
    );
    return csvResponse(`1099-${r.year}.csv`, body);
  } catch (err) {
    const e = toAppError(err);
    return new Response(e.message, { status: e.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
