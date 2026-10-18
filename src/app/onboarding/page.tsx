import { redirect } from "next/navigation";
import { getCurrentOrg, requireUser } from "@/lib/auth";
import { OnboardingForm } from "./form";

/**
 * Create an organization. First login lands here (no membership yet);
 * existing users come via the org switcher's "New organization" link
 * (`?new=1`) to add another company.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const user = await requireUser();
  const { new: addAnother } = await searchParams;
  const current = await getCurrentOrg();
  if (current && !addAnother) redirect("/dashboard");

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-primary grid place-items-center">
              <span className="font-heading text-primary-foreground text-xl">
                G
              </span>
            </div>
            <div className="text-left">
              <div className="font-heading text-xl tracking-[0.2em]">
                GROUNDWORKS
              </div>
              <div className="text-[10px] tracking-[0.3em] text-muted-foreground uppercase">
                Let&apos;s set up your company
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="font-heading text-2xl tracking-[0.1em] mb-1">
            CREATE YOUR ORGANIZATION
          </h1>
          <p className="text-xs text-muted-foreground mb-6">
            You&apos;re signed in as <span className="text-foreground">{user.email}</span>.
            Name the company you&apos;ll be running on Groundworks.
          </p>

          <OnboardingForm />
        </div>

        <p className="text-[11px] text-center text-muted-foreground mt-6">
          You&apos;ll be the owner. You can invite teammates next.
        </p>
      </div>
    </div>
  );
}
