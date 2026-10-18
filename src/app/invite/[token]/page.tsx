import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { findInvitation } from "@/lib/team/service";
import { AcceptButton } from "./accept-button";

/**
 * Invitation landing page. The proxy sends signed-out visitors to login
 * first (with a redirect back here), so by now we know who they are.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser();
  const invite = await db.transaction((tx) => findInvitation(tx, token));
  const emailMatches = invite && invite.email.toLowerCase() === user.email.toLowerCase();

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 space-y-4">
        <div className="font-heading text-xl tracking-[0.15em]">GROUNDWORKS</div>
        {!invite ? (
          <>
            <p className="text-sm">This invitation is invalid, expired, or already used.</p>
            <p className="text-xs text-muted-foreground">Ask whoever invited you to send a new link.</p>
          </>
        ) : !emailMatches ? (
          <>
            <p className="text-sm">
              This invitation to <strong>{invite.organizationName}</strong> is for{" "}
              <span className="font-mono">{invite.email}</span>.
            </p>
            <p className="text-xs text-muted-foreground">
              You&apos;re signed in as {user.email}. Sign out and sign back in with the invited address.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm">
              You&apos;ve been invited to join <strong>{invite.organizationName}</strong> as{" "}
              <span className="capitalize">{invite.role}</span>.
            </p>
            <AcceptButton token={token} />
          </>
        )}
        <Link href="/dashboard" className="block text-xs text-muted-foreground hover:text-foreground">
          Go to my dashboard
        </Link>
      </div>
    </div>
  );
}
