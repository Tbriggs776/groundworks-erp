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
 * own title + crumb; the shell handles nav + topbar. Below `md` the sidebar
 * collapses into a drawer opened from the topbar.
 */
export function AppShell({ title, crumb, userEmail, children }: Props) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <Topbar title={title} crumb={crumb} userEmail={userEmail} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
