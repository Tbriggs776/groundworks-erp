import { requireCurrentOrg } from "@/lib/auth";

/**
 * The (app) route group requires:
 *   1. An authenticated user (middleware / proxy catches anon earlier)
 *   2. An active membership — if none, bounce to /onboarding so the user
 *      creates their first org.
 *
 * Once both are satisfied, every child route has a guaranteed user + org.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireCurrentOrg();
  return <>{children}</>;
}
