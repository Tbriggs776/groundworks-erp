"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { inviteTeam, type TeamInviteResult, type TeamInviteRow } from "./actions";

const ACCESS: Array<{ value: TeamInviteRow["access"]; label: string }> = [
  { value: "bookkeeper", label: "Bookkeeper" },
  { value: "accountant", label: "Accountant" },
  { value: "admin", label: "Admin" },
  { value: "viewer", label: "View only" },
];
const field = "rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

export function TeamInviteForm({ emailEnabled }: { emailEnabled: boolean }) {
  const [rows, setRows] = useState<TeamInviteRow[]>([{ email: "", access: "bookkeeper" }]);
  const [results, setResults] = useState<TeamInviteResult[] | null>(null);
  const [pending, start] = useTransition();
  const set = (i: number, patch: Partial<TeamInviteRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  if (results) {
    return (
      <div className="space-y-4">
        <ul className="space-y-2 text-sm">
          {results.map((r) => (
            <li key={r.email} className="rounded-md border border-border p-2">
              <div className="font-medium">{r.email}</div>
              {"error" in r ? (
                <div className="text-xs text-destructive">{r.error}</div>
              ) : r.emailed ? (
                <div className="text-xs text-muted-foreground">Invitation emailed.</div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Send them this link: <span className="font-mono break-all select-all text-foreground">{r.link}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
        <Link href="/dashboard" className={buttonVariants({ className: "w-full" })}>
          Go to my books
        </Link>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setResults(await inviteTeam(rows)));
      }}
    >
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2">
          <input
            type="email"
            aria-label="Email"
            placeholder="teammate@company.com"
            value={row.email}
            onChange={(e) => set(i, { email: e.target.value })}
            className={`${field} flex-1 min-w-0`}
          />
          <select aria-label="Access" value={row.access} onChange={(e) => set(i, { access: e.target.value as TeamInviteRow["access"] })} className={field}>
            {ACCESS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>
      ))}
      {rows.length < 10 && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setRows((r) => [...r, { email: "", access: "bookkeeper" }])}>
          + Add another
        </button>
      )}
      <p className="text-[11px] text-muted-foreground">
        {emailEnabled ? "We'll email each person a link." : "Email isn't set up yet, so you'll get links to send yourself."} Links expire in 7 days.
      </p>
      <div className="flex gap-2">
        <Link href="/dashboard" className={buttonVariants({ variant: "outline", className: "flex-1" })}>
          Skip for now
        </Link>
        <Button type="submit" className="flex-1" disabled={pending || !rows.some((r) => r.email.trim())}>
          {pending ? "Inviting…" : "Send invites"}
        </Button>
      </div>
    </form>
  );
}
