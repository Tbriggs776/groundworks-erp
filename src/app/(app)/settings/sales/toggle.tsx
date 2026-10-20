"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Checkbox } from "@/components/ui/checkbox";
import { setAutoApplyCredits } from "../../ar/sales-actions";

export function AutoApplyToggle({ on, canEdit }: { on: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={on}
          disabled={!canEdit || pending}
          onCheckedChange={(v) =>
            start(async () => {
              setErr(null);
              const r = await setAutoApplyCredits(v === true);
              if (!r.ok) setErr(r.error);
              router.refresh();
            })
          }
        />
        {on ? "On" : "Off"}
      </label>
      {!canEdit && <p className="text-[11px] text-muted-foreground">Only admins can change this.</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
