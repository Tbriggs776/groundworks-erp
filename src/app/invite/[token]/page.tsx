import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { findInvitation } from "@/lib/workspace/service";
import { AuthFrame } from "@/components/auth-frame";
import { AcceptButton } from "./accept-button";

/**
 * Invitation landing page. The proxy sends signed-out visitors to sign in
 * first (with a redirect back here); a new person creates an account from
 * there and comes straight back. By now we know who they are.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser();
  const invite = await db.transaction((tx) => findInvitation(tx, token));
  const emailMatches = invite && invite.email.toLowerCase() === user.email.toLowerCase();

  return (
    <AuthFrame tagline="Invitation">
      <div className="space-y-4">
        {!invite ? (
          <>
            <p className="text-sm">This invitation is invalid, expired, or already used.</p>
            <p className="text-xs text-muted-foreground">Ask whoever invited you to send a new link.</p>
          </>
        ) : !emailMatches ? (
          <>
            <p className="text-sm">
              This invitation to <strong>{invite.workspaceName}</strong> is for{" "}
              <span className="font-mono">{invite.email}</span>.
            </p>
            <p className="text-xs text-muted-foreground">
              You&apos;re signed in as {user.email}. Sign out and sign back in with the invited address.
            </p>
            <form action="/auth/signout" method="post">
              <button type="submit" className="text-xs text-primary hover:underline">Sign out</button>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm">
              You&apos;ve been invited to <strong>{invite.workspaceName}</strong>
              {invite.workspaceRole !== "member" && <> as a workspace {invite.workspaceRole}</>}.
            </p>
            {invite.grants.length > 0 && (
              <ul className="text-xs text-muted-foreground space-y-1">
                {invite.grants.map((g) => (
                  <li key={g.organizationId}>
                    {g.companyName}: <span className="capitalize text-foreground">{g.role}</span>
                  </li>
                ))}
              </ul>
            )}
            <AcceptButton token={token} />
          </>
        )}
        <Link href="/dashboard" className="block text-xs text-muted-foreground hover:text-foreground">
          Go to my dashboard
        </Link>
      </div>
    </AuthFrame>
  );
}
