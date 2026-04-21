import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  budgetEntries,
  budgets,
  fiscalPeriods,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { BudgetEditor } from "./budget-editor";

export default async function EditBudgetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [budget] = await db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.id, id),
        eq(budgets.organizationId, organization.id)
      )
    );
  if (!budget) notFound();

  const [entries, acctRows, periodRows] = await Promise.all([
    db
      .select({
        entry: budgetEntries,
        account: accounts,
        period: fiscalPeriods,
      })
      .from(budgetEntries)
      .innerJoin(accounts, eq(accounts.id, budgetEntries.accountId))
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, budgetEntries.periodId))
      .where(eq(budgetEntries.budgetId, id))
      .orderBy(asc(fiscalPeriods.periodNo), asc(accounts.code)),
    db
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, organization.id))
      .orderBy(asc(accounts.code)),
    db
      .select()
      .from(fiscalPeriods)
      .where(eq(fiscalPeriods.fiscalYearId, budget.fiscalYearId))
      .orderBy(asc(fiscalPeriods.periodNo)),
  ]);

  const entriesFlat = entries.map((r) => ({
    ...r.entry,
    account: r.account,
    period: r.period,
  }));

  return (
    <AppShell
      title={`Budget ${budget.code}`}
      crumb={`${organization.name} · Financials · Budgets`}
      userEmail={user?.email}
    >
      <BudgetEditor
        budget={budget}
        entries={entriesFlat}
        accounts={acctRows}
        periods={periodRows}
      />
    </AppShell>
  );
}
