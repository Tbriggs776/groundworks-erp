import { redirect } from "next/navigation";
import { getSessionVerdict, getUser } from "@/lib/auth";
import { safeRedirectPath } from "@/lib/ui/redirect";
import { BrandMark } from "@/components/brand-mark";
import { MfaStep } from "./mfa-step";

/**
 * Two-step verification. requireUser sends people here when their session
 * hasn't used a second factor but must: they enrolled one, or a workspace
 * they belong to requires it. The client component decides between
 * "set up an authenticator app" and "enter your code".
 */
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/auth/login");
  const verdict = await getSessionVerdict();
  if (verdict?.ok) redirect("/dashboard");
  if (verdict && verdict.reason !== "mfa_required") redirect(`/auth/signout?reason=${verdict.reason}`);
  const { redirectTo } = await searchParams;
  const target = safeRedirectPath(redirectTo);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <BrandMark size={48} />
          <div className="font-heading text-lg tracking-[0.18em] mt-3">GROUNDWORKS</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 space-y-4 shadow-[0_1px_3px_rgb(27_42_78/0.06),0_8px_24px_-12px_rgb(27_42_78/0.12)]">
          <div>
            <h1 className="font-heading text-xl tracking-[0.1em]">TWO-STEP VERIFICATION</h1>
            <p className="text-xs text-muted-foreground mt-1">
              Signed in as <span className="text-foreground">{user.email}</span>.
              {verdict?.policy.requireMfa ? " Your workspace requires a second factor." : ""}
            </p>
          </div>
          <MfaStep redirectTo={target} />
          <form action="/auth/signout" method="post">
            <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
