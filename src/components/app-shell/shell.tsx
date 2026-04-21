import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

type Props = {
  title: string;
  crumb?: string;
  userEmail?: string | null;
  children: React.ReactNode;
};

/**
 * Wraps every authenticated page in the standard shell. Pages provide their
 * own title + crumb; the shell handles nav + topbar.
 */
export function AppShell({ title, crumb, userEmail, children }: Props) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar title={title} crumb={crumb} userEmail={userEmail} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
