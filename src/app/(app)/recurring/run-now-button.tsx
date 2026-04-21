"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { runRecurringNow } from "./actions";

/**
 * Triggers the recurring runner on-demand. Complements the daily Vercel cron;
 * handy for immediate regeneration after creating a new recurring that's due
 * today.
 */
export function RunNowButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function go() {
    setMsg(null);
    start(async () => {
      const r = await runRecurringNow();
      if (!r.ok) {
        setMsg(`Error: ${r.error}`);
        return;
      }
      setMsg(
        r.generated > 0
          ? `Generated ${r.generated} of ${r.checked} due.`
          : "Nothing due right now."
      );
    });
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
      <Button variant="ghost" size="sm" onClick={go} disabled={pending}>
        {pending ? "Running…" : "Run now"}
      </Button>
    </div>
  );
}
