"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { TotpEnroll } from "@/components/totp";
import { createClient } from "@/lib/supabase/client";
import { signOutOtherSessions } from "./actions";

export function MfaSettings({ enrolled, required }: { enrolled: boolean; required: boolean }) {
  const router = useRouter();
  const [setting, setSetting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (setting) {
    return (
      <div className="max-w-sm rounded-md border border-border p-4">
        <TotpEnroll
          onEnrolled={() => {
            setSetting(false);
            router.refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <p className="text-sm">
        {enrolled
          ? "On. You'll enter a code from your authenticator app when you sign in."
          : "Off. Add an authenticator app so a stolen email inbox isn't enough to get into your books."}
        {required && <span className="text-muted-foreground"> Your workspace requires it.</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        {!enrolled && <Button onClick={() => setSetting(true)}>Set up authenticator app</Button>}
        {enrolled && !required && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setErr(null);
                const auth = createClient().auth;
                const { data } = await auth.mfa.listFactors();
                for (const f of data?.totp ?? []) {
                  const { error } = await auth.mfa.unenroll({ factorId: f.id });
                  if (error) {
                    setErr(error.message);
                    return;
                  }
                }
                await auth.refreshSession();
                router.refresh();
              })
            }
          >
            Turn off
          </Button>
        )}
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

type SessionView = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastSeenAt: string;
  authenticatedAt: string;
  mfa: boolean;
};

function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function SessionList({ sessions, currentSessionId }: { sessions: SessionView[]; currentSessionId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const others = sessions.filter((s) => s.id !== currentSessionId).length;
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-md border border-border text-sm">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="font-medium">{device(s.userAgent)}</span>
            {s.id === currentSessionId && <span className="text-[10px] uppercase tracking-wider text-primary">This device</span>}
            <span className="text-xs text-muted-foreground">
              {s.ipAddress ?? "unknown IP"} · signed in {new Date(s.authenticatedAt).toLocaleString()} · last active{" "}
              {new Date(s.lastSeenAt).toLocaleString()}
              {s.mfa ? " · 2-step" : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          disabled={pending || others === 0}
          onClick={() =>
            start(async () => {
              const r = await signOutOtherSessions();
              setMsg(`Signed out ${r.ended} other session${r.ended === 1 ? "" : "s"}.`);
              router.refresh();
            })
          }
        >
          Sign out everywhere else
        </Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}
