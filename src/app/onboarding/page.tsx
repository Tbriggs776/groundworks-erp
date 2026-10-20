import { redirect } from "next/navigation";
import { getUserWorkspaces, requireUser } from "@/lib/auth";
import { AuthFrame } from "@/components/auth-frame";
import { CompanyForm } from "@/components/company-form";
import { startWorkspace } from "./actions";

/**
 * Sign-up step 1: name the company. New users land here right after they
 * create an account (from /signup the company name is already filled in). Existing
 * users come with `?new=1` to start a separate workspace; adding a company
 * to the current workspace lives under Workspace → Companies.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; company?: string }>;
}) {
  const user = await requireUser();
  const { new: another, company } = await searchParams;
  if (!another && (await getUserWorkspaces()).length > 0) redirect("/dashboard");

  return (
    <AuthFrame
      wide
      tagline={another ? "New workspace" : "Step 1 of 2 · Your company"}
      footer="You'll be the owner. You can invite teammates and add more companies next."
    >
      <h1 className="font-heading text-2xl tracking-[0.1em] mb-1">SET UP YOUR COMPANY</h1>
      <p className="text-xs text-muted-foreground mb-6">
        Signed in as <span className="text-foreground">{user.email}</span>.
      </p>
      <CompanyForm action={startWorkspace} defaultName={company?.slice(0, 100)} submitLabel="Create company" askWorkspaceName />
    </AuthFrame>
  );
}
