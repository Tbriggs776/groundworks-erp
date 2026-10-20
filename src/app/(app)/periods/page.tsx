import Link from "next/link";
import { format, parseISO } from "date-fns";
import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { fiscalPeriods, fiscalYears } from "@/lib/db/schema";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { hasClosingPassword, listCloseTasks } from "@/lib/gl/close";
import { ClosingPassword, CloseTasks } from "./close-settings";
import { PeriodsClient } from "./periods-client";

export default async function PeriodsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [tasks, passwordSet] = await runAs(actor, (ctx) => Promise.all([listCloseTasks(ctx), hasClosingPassword(ctx)]));
  const person = actor.kind === "user" && !actor.support;

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

  // The books are closed through the end of the last period in the unbroken
  // run of closed periods from the start.
  let closedThrough: { date: string; hard: boolean } | null = null;
  for (const p of periods) {
    if (p.status === "open") break;
    closedThrough = { date: p.endDate, hard: p.status === "hard_closed" };
  }

  return (
    <AppShell
      title="Close Books"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3 text-sm">
          <div>
            {closedThrough ? (
              <>
                Books closed through <span className="font-semibold">{format(parseISO(closedThrough.date), "MMM d, yyyy")}</span>
                <span className="text-muted-foreground">{closedThrough.hard ? " (hard closed)" : " (soft closed)"}</span>
              </>
            ) : (
              <span className="text-muted-foreground">No period is closed yet. Open a period&apos;s checklist to close it.</span>
            )}
          </div>
          <Link href="/reports/changes-after-close" className="text-xs text-primary hover:underline">
            Changes after close →
          </Link>
        </div>
        <PeriodsClient
          years={yearsWithPeriods}
          nextSuggestedYear={nextSuggestedYear}
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <CloseTasks tasks={tasks} canEdit={person && hasRole(actor.role, "accountant")} />
          <ClosingPassword isSet={passwordSet} canEdit={person && actor.role === "owner"} />
        </div>
      </div>
    </AppShell>
  );
}
