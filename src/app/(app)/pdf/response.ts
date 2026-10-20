import { toAppError } from "@/lib/errors";
import type { PdfFile } from "@/lib/pdf/documents";

/** A PDF shown in the browser tab (Save keeps the file name). */
export function pdfResponse(f: PdfFile, download = false): Response {
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      "content-type": f.contentType,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${f.fileName}"`,
      "cache-control": "private, no-store",
    },
  });
}

/** Service errors as plain text with the matching status (404 for another company's ids). */
export function pdfError(err: unknown): Response {
  const e = toAppError(err);
  return new Response(e.message, { status: e.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
