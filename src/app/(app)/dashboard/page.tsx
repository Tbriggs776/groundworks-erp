import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell/shell";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <AppShell
      title="Dashboard"
      crumb="Financials · Overview"
      userEmail={user?.email}
    >
      <div className="max-w-5xl">
        <div className="rounded-lg border border-border bg-card p-8">
          <div className="text-[10px] tracking-[0.28em] uppercase text-primary mb-2">
            Tier 0 · Platform Online
          </div>
          <h1 className="font-heading text-4xl tracking-[0.08em] text-foreground mb-4">
            WELCOME TO GROUNDWORKS
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
            The platform slab is live: multi-tenant schema, Supabase auth,
            Drizzle migrations, audit log, money + period utilities, and the
            shell. Domain modules light up from here.
          </p>

          <div className="grid grid-cols-3 gap-3 mt-8">
            {[
              { label: "Organizations", value: "—" },
              { label: "Active Jobs", value: "—" },
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
