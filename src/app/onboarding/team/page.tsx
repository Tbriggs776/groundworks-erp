import { AuthFrame } from "@/components/auth-frame";
import { requireCurrentOrg, requireWorkspace } from "@/lib/auth";
import { emailConfigured } from "@/lib/email";
import { TeamInviteForm } from "./team-form";

/** Sign-up step 2: invite the team (optional). */
export default async function OnboardingTeamPage() {
  await requireWorkspace("admin");
  const { organization } = await requireCurrentOrg();
  return (
    <AuthFrame wide tagline="Step 2 of 2 · Your team" footer="You can always invite people later from Workspace → People.">
      <h1 className="font-heading text-2xl tracking-[0.1em] mb-1">INVITE YOUR TEAM</h1>
      <p className="text-xs text-muted-foreground mb-6">
        Who else works on {organization.name}&apos;s books? Each person gets their own sign-in.
      </p>
      <TeamInviteForm emailEnabled={emailConfigured()} />
    </AuthFrame>
  );
}
