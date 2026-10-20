"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCloseTaskAction, setClosingPasswordAction, updateCloseTaskAction } from "./actions";

const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";

/** The company's own month-end steps, signed off on each period's checklist. */
export function CloseTasks({ tasks, canEdit }: { tasks: Array<{ id: string; title: string; description: string | null; isActive: boolean }>; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function add() {
    setErr(null);
    start(async () => {
      const r = await createCloseTaskAction({ title: title.trim(), description: description.trim() || undefined });
      if (!r.ok) setErr(r.error);
      else {
        setTitle("");
        setDescription("");
        router.refresh();
      }
    });
  }

  function toggle(id: string, isActive: boolean) {
    setErr(null);
    start(async () => {
      const r = await updateCloseTaskAction({ id, isActive });
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  }

  return (
    <section id="checklist" className="rounded-md border border-border p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Checklist items</h2>
        <p className="text-xs text-muted-foreground">Steps your team signs off every month, alongside the automatic checks.</p>
      </div>
      {tasks.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      <ul className="divide-y divide-border">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start justify-between gap-3 py-2">
            <div className={t.isActive ? "" : "opacity-50"}>
              <div className="text-sm">{t.title}</div>
              {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
            </div>
            {canEdit && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggle(t.id, !t.isActive)}>
                {t.isActive ? "Retire" : "Restore"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <Label className={label}>New item</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Review payroll" />
          </div>
          <div>
            <Label className={label}>Details (optional)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <Button disabled={pending || !title.trim()} onClick={add}>
            Add
          </Button>
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </section>
  );
}

/** The password hard close, reopening, and posting into a hard-closed period ask for. Owners only. */
export function ClosingPassword({ isSet, canEdit }: { isSet: boolean; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function save() {
    setMsg(null);
    start(async () => {
      const r = await setClosingPasswordAction({ password: next, currentPassword: isSet ? current : undefined });
      if (!r.ok) setMsg({ ok: false, text: r.error });
      else {
        setMsg({ ok: true, text: "Saved." });
        setCurrent("");
        setNext("");
      }
    });
  }

  return (
    <section id="password" className="rounded-md border border-border p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Closing password</h2>
        <p className="text-xs text-muted-foreground">
          {isSet ? "Set." : "Not set yet."} Hard closing, reopening a hard-closed period, and posting into one all ask for it. Only the owner sets it.
        </p>
      </div>
      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          {isSet && (
            <div>
              <Label className={label}>Current password</Label>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="off" />
            </div>
          )}
          <div>
            <Label className={label}>{isSet ? "New password" : "Password"}</Label>
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
          <Button disabled={pending || next.length < 8 || (isSet && !current)} onClick={save}>
            {isSet ? "Change" : "Set"}
          </Button>
        </div>
      )}
      {msg && <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>{msg.text}</p>}
    </section>
  );
}
