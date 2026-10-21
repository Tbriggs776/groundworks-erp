"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateEmailSettingsAction } from "@/app/(app)/_email/actions";

const label = "text-xs uppercase tracking-wider text-muted-foreground mb-1.5";

type Template = { subject: string; body: string };

/** Reply-to, copy, the reminder schedule, and the template for each document type. */
export function EmailSettingsForm({
  canEdit,
  initial,
  keys,
  placeholders,
}: {
  canEdit: boolean;
  initial: {
    replyTo: string;
    effectiveReplyTo: string | null;
    copyTo: string;
    remindersEnabled: boolean;
    reminderDays: number[];
    templates: Record<string, Template>;
    customized: string[];
  };
  keys: Array<{ key: string; label: string }>;
  placeholders: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [replyTo, setReplyTo] = useState(initial.replyTo);
  const [copyTo, setCopyTo] = useState(initial.copyTo);
  const [remindersEnabled, setRemindersEnabled] = useState(initial.remindersEnabled);
  const [days, setDays] = useState(initial.reminderDays.join(", "));
  const [key, setKey] = useState(keys[0].key);
  const [templates, setTemplates] = useState(initial.templates);
  const t = templates[key];

  function save(extra: { templates?: Record<string, Template | null> } = {}) {
    setMsg(null);
    const reminderDays = days.split(/[,\s]+/).filter(Boolean).map(Number);
    if (reminderDays.some((d) => !Number.isInteger(d))) {
      setMsg({ ok: false, text: "Reminder days are whole numbers, like -3, 0, 7, 30." });
      return;
    }
    start(async () => {
      const r = await updateEmailSettingsAction({
        replyTo: replyTo.trim() || null,
        copyTo: copyTo.trim() || null,
        remindersEnabled,
        reminderDays,
        ...extra,
      });
      if (!r.ok) setMsg({ ok: false, text: r.error });
      else {
        setTemplates(r.settings.templates);
        setDays(r.settings.reminderDays.join(", "));
        setMsg({ ok: true, text: "Saved." });
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-md border border-border p-4 space-y-3">
        <h2 className="text-sm font-semibold">Sender</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className={label}>Replies go to</Label>
            <Input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} disabled={!canEdit} placeholder={initial.effectiveReplyTo ?? "billing@yourcompany.com"} />
            <p className="text-[11px] text-muted-foreground mt-1">Empty: the email on the company profile{initial.effectiveReplyTo && !initial.replyTo ? ` (${initial.effectiveReplyTo})` : ""}.</p>
          </div>
          <div>
            <Label className={label}>Copy every email to</Label>
            <Input value={copyTo} onChange={(e) => setCopyTo(e.target.value)} disabled={!canEdit} placeholder="records@yourcompany.com" />
            <p className="text-[11px] text-muted-foreground mt-1">Sent as a blind copy, for your records.</p>
          </div>
        </div>
      </section>

      <section className="rounded-md border border-border p-4 space-y-3">
        <h2 className="text-sm font-semibold">Payment reminders</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={remindersEnabled} onChange={(e) => setRemindersEnabled(e.target.checked)} disabled={!canEdit} />
          Send reminders automatically
        </label>
        <div className="max-w-sm">
          <Label className={label}>On these days</Label>
          <Input value={days} onChange={(e) => setDays(e.target.value)} disabled={!canEdit} />
          <p className="text-[11px] text-muted-foreground mt-1">
            Relative to the due date: -3 is three days before, 0 the due date, 7 a week late. Each open invoice gets one reminder per day listed,
            to the email saved on the customer.
          </p>
        </div>
      </section>

      <section className="rounded-md border border-border p-4 space-y-3">
        <h2 className="text-sm font-semibold">Templates</h2>
        <div className="flex flex-wrap gap-1">
          {keys.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKey(k.key)}
              className={`rounded-md px-2.5 py-1 text-xs ${k.key === key ? "bg-primary/15 text-primary font-semibold" : "text-muted-foreground hover:bg-accent"}`}
            >
              {k.label}
              {initial.customized.includes(k.key) ? " ·" : ""}
            </button>
          ))}
        </div>
        <div>
          <Label className={label}>Subject</Label>
          <Input value={t.subject} onChange={(e) => setTemplates({ ...templates, [key]: { ...t, subject: e.target.value } })} disabled={!canEdit} />
        </div>
        <div>
          <Label className={label}>Message</Label>
          <Textarea value={t.body} onChange={(e) => setTemplates({ ...templates, [key]: { ...t, body: e.target.value } })} rows={8} disabled={!canEdit} />
        </div>
        <p className="text-[11px] text-muted-foreground">Placeholders: {placeholders.map((p) => `{${p}}`).join(" ")}</p>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => save({ templates: { [key]: templates[key] } })}>
              Save template
            </Button>
            {initial.customized.includes(key) && (
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => save({ templates: { [key]: null } })}>
                Restore default
              </Button>
            )}
          </div>
        )}
      </section>

      {canEdit ? (
        <Button disabled={pending} onClick={() => save()}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">Admins change email settings.</p>
      )}
      {msg && <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>{msg.text}</p>}
    </div>
  );
}
