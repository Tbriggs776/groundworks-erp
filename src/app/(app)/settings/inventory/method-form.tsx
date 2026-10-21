"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCostingMethod } from "../../items/inventory-actions";

const OPTIONS = [
  { value: "fifo", label: "FIFO (first in, first out)" },
  { value: "average", label: "Weighted average" },
  { value: "specific", label: "Specific identification (by lot number, with expiration dates)" },
] as const;

export function MethodForm({ method, canEdit }: { method: (typeof OPTIONS)[number]["value"]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {OPTIONS.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="costing-method"
            checked={method === o.value}
            disabled={!canEdit || pending}
            onChange={() =>
              start(async () => {
                setErr(null);
                const r = await setCostingMethod(o.value);
                if (!r.ok) setErr(r.error);
                router.refresh();
              })
            }
          />
          {o.label}
        </label>
      ))}
      {!canEdit && <p className="text-[11px] text-muted-foreground">Only admins can change this.</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
