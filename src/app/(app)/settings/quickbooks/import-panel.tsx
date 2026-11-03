"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ImportView } from "@/lib/qbo/service";
import { disconnectQbo, runQuickBooksBatch } from "./actions";

/**
 * Runs the import a batch at a time while the page is open, and shows where
 * it stands. Closing the page pauses it; coming back picks up where it
 * stopped.
 */

/** A batch the platform stops gets retried this many times in a row before the page gives up. */
const RETRIES = 4;
const RETRY_DELAY_MS = 3000;
export function ImportPanel({ initial, canRun }: { initial: ImportView; canRun: boolean }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(initial.status === "failed" ? initial.lastError : null);
  const [pending, start] = useTransition();
  const stop = useRef(false);

  async function loop() {
    setRunning(true);
    setErr(null);
    stop.current = false;
    let stopped = 0;
    for (;;) {
      let r: Awaited<ReturnType<typeof runQuickBooksBatch>>;
      try {
        r = await runQuickBooksBatch();
      } catch {
        // The request died without an answer: the platform stopped the
        // batch before it saved. The next batch knows which record it was
        // on and skips one that keeps doing it, so try again.
        stopped += 1;
        if (stopped > RETRIES) {
          setErr("The import keeps stopping before it can save. Wait a few minutes, then continue; your progress so far is kept.");
          break;
        }
        setErr(`A batch was stopped before it could save. Trying again (${stopped} of ${RETRIES})…`);
        await new Promise((ok) => setTimeout(ok, RETRY_DELAY_MS));
        if (stop.current) break;
        continue;
      }
      if (!r.ok) {
        setErr(r.error);
        break;
      }
      stopped = 0;
      setErr(null);
      setView(r.view);
      if (r.view.status !== "running" || stop.current) break;
    }
    setRunning(false);
    router.refresh();
  }

  useEffect(() => {
    const auto = canRun && initial.status === "running" && initial.connection?.connected;
    const t = auto ? setTimeout(() => void loop(), 0) : undefined;
    return () => {
      clearTimeout(t);
      stop.current = true;
    };
    // Start once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conn = view.connection;
  const total = view.steps.reduce((acc, s) => acc + s.imported, 0);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold">{conn?.companyName ?? "QuickBooks company"}</div>
          <div className="text-xs text-muted-foreground">
            {conn ? `QuickBooks ${conn.environment === "sandbox" ? "sandbox " : ""}company ${conn.realmId}` : ""}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {view.status === "done"
            ? `Import finished: ${total} records came across.`
            : view.status === "failed"
              ? "The import stopped. Nothing from the failed batch was saved; try again to pick up where it left off."
              : running
                ? "Importing. Keep this page open; closing it pauses the import, and coming back resumes it."
                : "The import is paused."}
        </p>
        {view.interrupted && !running && view.status === "running" && (
          <p className="text-sm">
            The last batch was stopped before it could save
            {view.interrupted.label ? `, while importing ${view.interrupted.label}` : ""}. Continue to pick up where it left off. A record
            that stops the import twice is skipped and listed under To review, for you to enter by hand.
          </p>
        )}
        {conn && !conn.connected && (
          <p className="text-sm">
            QuickBooks is disconnected.{" "}
            {canRun && (
              <a href="/api/qbo/connect?reconnect=1" className="text-primary hover:underline">
                Reconnect
              </a>
            )}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium px-3 py-2">Step</th>
              <th className="text-right font-medium px-3 py-2 w-28">Imported</th>
              <th className="text-right font-medium px-3 py-2 w-28">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {view.steps.map((s) => (
              <tr key={s.key} className="border-t border-border">
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-2">
                    {s.state === "done" ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : s.state === "current" && running ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-full border border-border inline-block" />
                    )}
                    {s.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">{s.imported || ""}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{s.skipped || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {err && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">{err}</div>}

      {canRun && (
        <div className="flex flex-wrap gap-2">
          {view.status !== "done" && !running && conn?.connected && (
            <Button size="sm" onClick={() => void loop()}>
              {view.status === "failed" ? "Try again" : "Continue import"}
            </Button>
          )}
          {running && (
            <Button size="sm" variant="ghost" onClick={() => (stop.current = true)}>
              Pause
            </Button>
          )}
          {conn?.connected && !running && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await disconnectQbo();
                  if (!r.ok) setErr(r.error);
                  router.refresh();
                })
              }
            >
              Disconnect QuickBooks
            </Button>
          )}
        </div>
      )}

      {view.notes.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">To review ({view.notes.length})</div>
          <ul className="rounded-md border border-border divide-y divide-border text-sm">
            {view.notes.map((n, i) => (
              <li key={i} className="px-3 py-2">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
