import { asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { RevaluationClient } from "./revaluation-client";

export default async function RevaluationPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const acctRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.organizationId, organization.id))
    .orderBy(asc(accounts.code));

  return (
    <AppShell
      title="FX Revaluation"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
          Re-translates foreign-currency account balances at the spot rate
          as of the revaluation date and posts a balanced adjustment to
          unrealized FX gain / loss. Typically run at period-end with an
          auto-reverse date of day 1 of the following period — the
          revaluation unwinds automatically so it doesn&apos;t bleed into
          next period&apos;s actuals.
        </div>

        <RevaluationClient
          accounts={acctRows}
          baseCurrency={organization.baseCurrency}
        />
      </div>
    </AppShell>
  );
}
