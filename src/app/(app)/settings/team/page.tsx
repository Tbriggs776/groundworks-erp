import { redirect } from "next/navigation";

/** Team management moved to the workspace (one place for every company). */
export default function TeamPage() {
  redirect("/workspace/people");
}
