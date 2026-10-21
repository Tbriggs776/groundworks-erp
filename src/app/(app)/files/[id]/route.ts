import { runAs } from "@/lib/actor";
import { INLINE_TYPES, openAttachment } from "@/lib/attachments/service";
import { requireActor } from "@/lib/auth";
import { toAppError } from "@/lib/errors";

/**
 * GET /files/<id>: an attachment of the active company, for people signed
 * in. PDFs and images open in the tab; other files download. Add
 * ?download=1 to save any of them.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireActor();
  try {
    const f = await runAs(actor, (ctx) => openAttachment(ctx, id));
    const inline = INLINE_TYPES.has(f.contentType) && new URL(request.url).searchParams.get("download") !== "1";
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "content-type": f.contentType,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${f.fileName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    const e = toAppError(err);
    return new Response(e.message, { status: e.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
