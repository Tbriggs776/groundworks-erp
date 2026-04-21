import { AppShell } from "@/components/app-shell/shell";
import { requireCurrentOrg } from "@/lib/auth";
import { getUser } from "@/lib/auth";

export default async function DashboardPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();

  return (
    <AppShell
      title="Dashboard"
      crumb={`${organization.name} · Overview`}
      userEmail={user?.email}
    >
      <div className="max-w-5xl">
        <div className="rounded-lg border border-border bg-card p-8">
          <div className="text-[10px] tracking-[0.28em] uppercase text-primary mb-2">
            Tier 1 · Onboarded
          </div>
          <h1 className="font-heading text-4xl tracking-[0.08em] text-foreground mb-2">
            {organization.name.toUpperCase()}
          </h1>
          <div className="text-xs text-muted-foreground mb-6">
            {organization.baseCurrency} ·{" "}
            Fiscal year starts month {organization.fiscalYearStartMonth} ·{" "}
            You are <span className="text-primary">{role}</span>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            Platform is live. Signup trigger, RLS, and onboarding are wired.
            Next: Chart of Accounts and the General Ledger.
          </p>

          <div className="grid grid-cols-3 gap-3 mt-8">
            {[
              { label: "Active Jobs", value: "—" },
              { label: "Open AP", value: "—" },
              { label: "Period", value: "Open" },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-md border border-border bg-background p-4"
              >
                <div className="text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
                  {stat.label}
                </div>
                <div className="font-heading text-2xl tracking-wider mt-1">
                  {stat.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 text-[11px] text-muted-foreground">
          Next up: Chart of Accounts → GL → Job Cost.
        </div>
      </div>
    </AppShell>
  );
}
