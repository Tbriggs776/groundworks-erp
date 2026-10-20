import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getSalesSettings } from "@/lib/ar/settings";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { AutoApplyToggle } from "./toggle";

export default async function SalesSettingsPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const s = await runAs(actor, (ctx) => getSalesSettings(ctx));
  return (
    <AppShell title="Sales Settings" crumb={`${organization.name} · Settings`} userEmail={user?.email}>
      <div className="max-w-2xl space-y-4">
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="font-semibold">Apply credits automatically</div>
          <p className="text-xs text-muted-foreground">
            When on, a credit memo or an overpayment pays down the customer&apos;s open invoices, oldest first, as soon as it posts, and new
            invoices use any credit the customer already has. When off, credits wait until someone applies them.
          </p>
          <AutoApplyToggle on={s.autoApplyCredits} canEdit={hasRole(role, "admin")} />
        </div>
      </div>
    </AppShell>
  );
}
