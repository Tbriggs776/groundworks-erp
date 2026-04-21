import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { fiscalPeriods, fiscalYears } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { PeriodsClient } from "./periods-client";

export default async function PeriodsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const years = await db
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.organizationId, organization.id),
        isNull(fiscalYears.deletedAt)
      )
    )
    .orderBy(asc(fiscalYears.startDate));

  const periods = await db
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.organizationId, organization.id),
        isNull(fiscalPeriods.deletedAt)
      )
    )
    .orderBy(asc(fiscalPeriods.startDate));

  const yearsWithPeriods = years.map((y) => ({
    ...y,
    periods: periods.filter((p) => p.fiscalYearId === y.id),
  }));

  // Suggest "the next fiscal year" based on existing years or today.
  const lastYear = years[years.length - 1];
  const startMonth = organization.fiscalYearStartMonth;
  let nextStart: Date;
  let nextLabel: string;
  if (lastYear) {
    const [y, m, d] = lastYear.startDate.split("-").map(Number);
    nextStart = new Date(y + 1, m - 1, d);
    nextLabel = `FY${nextStart.getFullYear() + (startMonth === 1 ? 0 : 1)}`;
  } else {
    const today = new Date();
    const currentYearStart = new Date(today.getFullYear(), startMonth - 1, 1);
    nextStart =
      today >= currentYearStart
        ? currentYearStart
        : new Date(today.getFullYear() - 1, startMonth - 1, 1);
    nextLabel = `FY${
      nextStart.getFullYear() + (startMonth === 1 ? 0 : 1)
    }`;
  }

  const nextSuggestedYear = {
    label: nextLabel,
    startDate: nextStart.toISOString().slice(0, 10),
  };

  return (
    <AppShell
      title="Period Close"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <PeriodsClient
        years={yearsWithPeriods}
        nextSuggestedYear={nextSuggestedYear}
      />
    </AppShell>
  );
}
