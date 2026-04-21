import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Every authenticated route nests under (app). The middleware already
 * redirects anonymous users to /auth/login, but we double-check here in case
 * middleware is bypassed (e.g., in tests) and to expose the user to pages
 * via the root server boundary.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  return <>{children}</>;
}
