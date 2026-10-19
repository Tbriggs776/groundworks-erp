import { AppShell } from "@/components/app-shell/shell";
import { CompanyForm } from "@/components/company-form";
import { getUser, requireWorkspace } from "@/lib/auth";
import { addCompany } from "../../actions";

/** Add another company to the workspace (same sign-in, separate books). */
export default async function NewCompanyPage() {
  const { workspace } = await requireWorkspace("admin");
  const user = await getUser();
  return (
    <AppShell title="Add company" crumb={`${workspace.name} · Workspace`} userEmail={user?.email}>
      <div className="max-w-md rounded-lg border border-border bg-card p-6">
        <p className="text-xs text-muted-foreground mb-5">
          Each company has its own books: chart of accounts, customers, vendors, and reports. You&apos;ll be its owner;
          give others access from People.
        </p>
        <CompanyForm action={addCompany} submitLabel="Add company" />
      </div>
    </AppShell>
  );
}
