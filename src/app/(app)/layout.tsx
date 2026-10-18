import { redirect } from "next/navigation";
import { getUserWorkspaces, requireUser } from "@/lib/auth";

/**
 * The (app) route group requires a signed-in user whose session passes
 * policy (requireUser) and at least one workspace; brand-new users go to
 * onboarding. Company pages additionally call requireCurrentOrg.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  if ((await getUserWorkspaces()).length === 0) redirect("/onboarding");
  return <>{children}</>;
}
