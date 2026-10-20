"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { closePeriodAction, reopenPeriodAction, setCloseTaskAction } from "../actions";

/** Sign a checklist item off for this period, or take it back. */
export function TaskToggle({ periodId, taskId, done, disabled, title }: { periodId: string; taskId: string; done: boolean; disabled: boolean; title: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="pt-0.5">
      <input
        type="checkbox"
        className="h-4 w-4 accent-primary"
        checked={done}
        disabled={disabled || pending}
        aria-label={`Done: ${title}`}
        onChange={(e) => {
          setErr(null);
          const next = e.target.checked;
          start(async () => {
            const r = await setCloseTaskAction({ id: periodId, taskId, done: next });
            if (!r.ok) setErr(r.error);
            else router.refresh();
          });
        }}
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";

/** Close the books through this period, or reopen it. */
export function ClosePanel({
  periodId,
  periodCode,
  status,
  openItems,
  alsoCloses,
  canClose,
  hasPassword,
}: {
  periodId: string;
  periodCode: string;
  status: "open" | "soft_closed" | "hard_closed";
  openItems: number;
  alsoCloses: string[];
  canClose: boolean;
  hasPassword: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [level, setLevel] = useState<"soft" | "hard">(status === "soft_closed" ? "hard" : "soft");
  const [note, setNote] = useState("");
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");

  if (!canClose) {
    return <p className="text-xs text-muted-foreground">Admins and owners close and reopen periods. Agents can read this checklist.</p>;
  }

  function close() {
    setErr(null);
    start(async () => {
      const r = await closePeriodAction({ id: periodId, level, note: note.trim() || undefined, password: level === "hard" ? password : undefined });
      if (!r.ok) setErr(r.error);
      else {
        setDone(`Closed ${r.closed.join(", ")}${r.yearClosed ? `. ${r.yearClosed} is closed.` : "."}`);
        setPassword("");
        router.refresh();
      }
    });
  }

  function reopen() {
    setErr(null);
    start(async () => {
      const r = await reopenPeriodAction({ id: periodId, reason: reason.trim(), password: password || undefined });
      if (!r.ok) setErr(r.error);
      else {
        setDone(`Reopened ${r.reopened.join(", ")}.`);
        setPassword("");
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {status !== "hard_closed" && (
        <section className="rounded-md border border-border p-4 space-y-3">
          <h2 className="text-sm font-semibold">{status === "open" ? `Close ${periodCode}` : `Hard close ${periodCode}`}</h2>
          {alsoCloses.length > 0 && <p className="text-xs text-muted-foreground">Also closes {alsoCloses.join(", ")}, still open before it.</p>}
          {status === "open" && (
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="level" checked={level === "soft"} onChange={() => setLevel("soft")} className="accent-primary" />
                Soft close
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="level" checked={level === "hard"} onChange={() => setLevel("hard")} className="accent-primary" />
                Hard close
              </label>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {level === "soft"
              ? "Only adjusting entries and reversals post afterwards."
              : "Nothing posts afterwards without the closing password. Closing a fiscal year's last period closes the year."}
          </p>
          {openItems > 0 && (
            <div>
              <Label className={label}>Note (required: {openItems} item{openItems === 1 ? " is" : "s are"} open)</Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why it's closing anyway" />
            </div>
          )}
          {level === "hard" &&
            (hasPassword ? (
              <div>
                <Label className={label}>Closing password</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              </div>
            ) : (
              <p className="text-xs text-destructive">
                Set a closing password first on <Link href="/periods#password" className="underline">Close Books</Link>.
              </p>
            ))}
          <Button disabled={pending || (openItems > 0 && !note.trim()) || (level === "hard" && !password)} onClick={close}>
            {pending ? "Closing…" : level === "soft" ? "Close" : "Hard close"}
          </Button>
        </section>
      )}
      {status !== "open" && (
        <section className="rounded-md border border-border p-4 space-y-3">
          <h2 className="text-sm font-semibold">Reopen {periodCode}</h2>
          <p className="text-xs text-muted-foreground">Reopens it and every closed period after it. Logged, with your reason.</p>
          <div>
            <Label className={label}>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it's reopening" />
          </div>
          <div>
            <Label className={label}>Closing password (when hard closed)</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </div>
          <Button variant="outline" disabled={pending || !reason.trim()} onClick={reopen}>
            {pending ? "Reopening…" : "Reopen"}
          </Button>
        </section>
      )}
      {(err || done) && <p className={`text-xs sm:col-span-2 ${err ? "text-destructive" : "text-emerald-700"}`}>{err ?? done}</p>}
    </div>
  );
}
