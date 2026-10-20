"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queueCheckAgain } from "./ap-actions";
import type { CheckKind } from "@/lib/ap/checks";

/**
 * On a posted check: the PDF, and either where it waits to print or a way
 * to put it back in the queue (a jammed or spoiled check prints again under
 * a new number).
 */
export function CheckControls({ kind, id, bankAccountId, toPrint, canEdit }: { kind: CheckKind; id: string; bankAccountId: string; toPrint: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function requeue() {
    if (!window.confirm("Put this check back in Print checks? Its check number is cleared; it gets the next number when it prints.")) return;
    setErr(null);
    start(async () => {
      const r = await queueCheckAgain(kind, id);
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-3 text-xs">
        {toPrint ? (
          <Link href={`/banking/checks?account=${bankAccountId}`} className="text-primary hover:underline">
            Waiting to print →
          </Link>
        ) : (
          canEdit && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={requeue}>
              Print again later
            </Button>
          )
        )}
        <a
          href={`/pdf/checks?items=${kind}:${id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <Printer className="h-3.5 w-3.5" /> Check PDF
        </a>
      </div>
      {err && <p className="text-xs text-destructive max-w-xs text-right">{err}</p>}
    </div>
  );
}
