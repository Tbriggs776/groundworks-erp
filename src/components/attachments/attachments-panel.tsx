"use client";

import { useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FileText, Loader2, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AttachmentView } from "@/lib/attachments/service";
import type { AttachmentEntity } from "@/lib/db/schema";
import { deleteFile, uploadFile } from "@/app/(app)/files/actions";
import { ACCEPT, fileSize, shrinkImage } from "./shrink";

/** Receipts and other files on one document: open, add, remove. */
export function AttachmentsPanel({
  entityType,
  entityId,
  files,
  canEdit,
}: {
  entityType: AttachmentEntity;
  entityId: string;
  files: AttachmentView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);

  const upload = (list: FileList | null) =>
    start(async () => {
      const errs: string[] = [];
      for (const f of Array.from(list ?? [])) {
        const form = new FormData();
        form.set("file", await shrinkImage(f));
        form.set("entityType", entityType);
        form.set("entityId", entityId);
        form.set("path", path);
        const r = await uploadFile(form);
        if (!r.ok) errs.push(`${f.name}: ${r.error}`);
      }
      setErrors(errs);
      if (input.current) input.current.value = "";
      router.refresh();
    });

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-sm">
          <Paperclip className="h-4 w-4" /> Attachments{files.length > 0 && <span className="text-muted-foreground font-normal">({files.length})</span>}
        </div>
        {canEdit && (
          <>
            <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" aria-label="Attach files" onChange={(e) => upload(e.target.files)} />
            <Button size="sm" variant="outline" disabled={pending} onClick={() => input.current?.click()}>
              {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Attach files
            </Button>
          </>
        )}
      </div>
      {errors.map((e) => (
        <div key={e} className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
          {e}
        </div>
      ))}
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No receipts or files yet.{canEdit ? " PDFs, photos, and spreadsheets up to 4 MB." : ""}</p>
      ) : (
        <ul className="divide-y divide-border">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2">
              {f.contentType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt="" className="h-10 w-10 rounded border border-border object-cover" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded border border-border bg-muted">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <a href={f.url} target="_blank" rel="noreferrer" className="block truncate text-sm text-primary hover:underline">
                  {f.fileName}
                </a>
                <div className="text-[11px] text-muted-foreground">
                  {fileSize(f.sizeBytes)} · added {new Date(f.uploadedAt).toLocaleDateString()}
                  {f.uploadedByAgent ? " by an agent" : ""}
                </div>
              </div>
              {canEdit && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${f.fileName}`}
                  disabled={pending}
                  onClick={() => {
                    if (!window.confirm(`Remove ${f.fileName}? It's deleted for good.`)) return;
                    start(async () => {
                      const r = await deleteFile(f.id, path);
                      setErrors(r.ok ? [] : [r.error]);
                      router.refresh();
                    });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
