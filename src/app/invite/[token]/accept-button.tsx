"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "./actions";

export function AcceptButton({ token }: { token: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await acceptInvite(token);
            if (r?.error) setErr(r.error);
          })
        }
      >
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
