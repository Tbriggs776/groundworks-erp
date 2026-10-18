"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { completeReview } from "./actions";

export function CompleteReview() {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder="Notes (optional): what you changed, anything to follow up"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await completeReview(notes);
            if (!r.ok) setErr(r.error);
            else {
              setNotes("");
              router.refresh();
            }
          })
        }
      >
        {pending ? "Recording…" : "I've reviewed this access"}
      </Button>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
