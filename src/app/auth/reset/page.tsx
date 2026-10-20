import { requireUser } from "@/lib/auth";
import { AuthFrame } from "@/components/auth-frame";
import { NewPasswordForm } from "@/components/new-password-form";

/**
 * Where a reset link lands (via /auth/callback, which signed the person
 * in). requireUser applies session policy first, MFA included, so a reset
 * link alone can't get past two-step verification.
 */
export default async function ResetPasswordPage() {
  const user = await requireUser();
  return (
    <AuthFrame tagline="Reset password">
      <div className="space-y-4">
        <div>
          <h1 className="font-heading text-xl tracking-[0.1em]">NEW PASSWORD</h1>
          <p className="text-xs text-muted-foreground mt-1">
            For <span className="text-foreground">{user.email}</span>. Saving it signs you out everywhere else.
          </p>
        </div>
        <NewPasswordForm submitLabel="Save and continue" next="/dashboard" />
      </div>
    </AuthFrame>
  );
}
