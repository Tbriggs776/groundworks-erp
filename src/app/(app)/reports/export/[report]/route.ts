import { runAs } from "@/lib/actor";
import { requireActor } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { exportReport, REPORT_KEYS, type ReportKey } from "@/lib/reports/exports";

/**
 * GET /reports/export/<report>?format=csv|pdf&from=&to=&…: any report as a
 * file (see src/lib/reports/exports.ts). Each download is audited.
 */
export async function GET(request: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  if (!(REPORT_KEYS as readonly string[]).includes(report)) return new Response("Not found", { status: 404 });
  const sp = new URL(request.url).searchParams;
  const input = Object.fromEntries([...sp.entries()].filter(([, v]) => v !== ""));
  const actor = await requireActor();
  try {
    const f = await runAs(actor, (ctx) => exportReport(ctx, { ...input, report: report as ReportKey }));
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "content-type": f.contentType,
        "content-disposition": `${f.contentType.startsWith("application/pdf") ? "inline" : "attachment"}; filename="${f.fileName}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    const e = toAppError(err);
    return new Response(e.message, { status: e.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
