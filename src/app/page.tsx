import { redirect } from "next/navigation";

export default function RootPage() {
  // Authed users hit the app; the middleware redirects the unauthed ones
  // out to /auth/login.
  redirect("/dashboard");
}
