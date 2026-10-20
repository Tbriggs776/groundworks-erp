import { AppShell } from "@/components/app-shell/shell";
import { getSessionVerdict, requireUser } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { hasVerifiedFactor } from "@/lib/security/mfa";
import { listSessions } from "@/lib/security/sessions";
import { NewPasswordForm } from "@/components/new-password-form";
import { MfaSettings, SessionList } from "./security-client";

/** The signed-in person's own security: password, two-step verification, and sessions. */
export default async function MySecurityPage() {
  const user = await requireUser();
  const [sessions, verdict, enrolled] = await Promise.all([
    listSessions(user.id),
    getSessionVerdict(),
    db.transaction((tx) => hasVerifiedFactor(tx, user.id)),
  ]);
  const policy = verdict?.policy;

  return (
    <AppShell title="My security" crumb={user.email} userEmail={user.email}>
      <div className="max-w-3xl space-y-8">
        <section className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Password</div>
          <div className="max-w-sm rounded-md border border-border p-4">
            <NewPasswordForm submitLabel="Save password" />
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Two-step verification</div>
          <MfaSettings enrolled={enrolled === true} required={Boolean(policy?.requireMfa)} />
        </section>

        <section className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Where you&apos;re signed in</div>
          {policy && (
            <p className="text-xs text-muted-foreground">
              Sessions end after {policy.idleMinutes} minutes of inactivity or {policy.maxHours} hours in total.
            </p>
          )}
          <SessionList
            currentSessionId={user.sessionId}
            sessions={sessions.map((s) => ({
              id: s.id,
              userAgent: s.userAgent,
              ipAddress: s.ipAddress,
              lastSeenAt: s.lastSeenAt.toISOString(),
              authenticatedAt: s.authenticatedAt.toISOString(),
              mfa: s.aal === "aal2",
            }))}
          />
        </section>
      </div>
    </AppShell>
  );
}
