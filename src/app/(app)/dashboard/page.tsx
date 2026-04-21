import Link from "next/link";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  fiscalPeriods,
  glJournals,
  glLines,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";

export default async function DashboardPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();

  const today = new Date().toISOString().slice(0, 10);

  // Stats (parallel)
  const [
    acctCount,
    postedCount,
    openPeriod,
    periodDebits,
  ] = await Promise.all([
    db
      .select({ count: count() })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          isNull(accounts.deletedAt),
          eq(accounts.isActive, true)
        )
      ),
    db
      .select({ count: count() })
      .from(glJournals)
      .where(
        and(
          eq(glJournals.organizationId, organization.id),
          eq(glJournals.status, "posted")
        )
      ),
    db
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.organizationId, organization.id),
          eq(fiscalPeriods.status, "open"),
          sql`${fiscalPeriods.startDate} <= ${today}::date`,
          sql`${fiscalPeriods.endDate} >= ${today}::date`
        )
      )
      .limit(1),
    db
      .select({
        total: sql<string>`COALESCE(SUM(${glLines.debitLocal}), 0)::text`,
      })
      .from(glLines)
      .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, glJournals.periodId))
      .where(
        and(
          eq(glJournals.organizationId, organization.id),
          eq(glJournals.status, "posted"),
          sql`${fiscalPeriods.startDate} <= ${today}::date`,
          sql`${fiscalPeriods.endDate} >= ${today}::date`
        )
      ),
  ]);

  const currentPeriod = openPeriod[0];
  const stats = [
    { label: "Accounts", value: acctCount[0]?.count ?? 0, href: "/accounts" },
    { label: "Posted Journals", value: postedCount[0]?.count ?? 0, href: "/gl" },
    {
      label: "Current Period",
      value: currentPeriod?.periodCode ?? "—",
      href: "/periods",
      status: currentPeriod?.status,
    },
    {
      label: "Period Debits (Local)",
      value: formatMoney(periodDebits[0]?.total ?? "0"),
      href: "/gl",
    },
  ];

  return (
    <AppShell
      title="Dashboard"
      crumb={`${organization.name} · Overview`}
      userEmail={user?.email}
    >
      <div className="max-w-5xl space-y-6">
        <div className="rounded-lg border border-border bg-card p-8">
          <div className="text-[10px] tracking-[0.28em] uppercase text-primary mb-2">
            Groundworks · Live
          </div>
          <h1 className="font-heading text-4xl tracking-[0.08em] text-foreground mb-2">
            {organization.name.toUpperCase()}
          </h1>
          <div className="text-xs text-muted-foreground mb-6">
            {organization.baseCurrency} · Fiscal year starts month{" "}
            {organization.fiscalYearStartMonth} · You are{" "}
            <span className="text-primary">{role}</span>
          </div>

          <div className="grid grid-cols-4 gap-3">
            {stats.map((stat) => (
              <Link
                key={stat.label}
                href={stat.href}
                className="rounded-md border border-border bg-background p-4 hover:border-ring transition-colors"
              >
                <div className="text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
                  {stat.label}
                </div>
                <div className="font-heading text-2xl tracking-wider mt-1 truncate">
                  {stat.value}
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <QuickAction
            title="Post a Journal Entry"
            description="Manual GL entry with multi-line, balance check, dimensions, and audit trail."
            href="/gl/journals/new"
          />
          <QuickAction
            title="Review the Chart of Accounts"
            description={`${acctCount[0]?.count ?? 0} accounts seeded. Add, edit, or block any of them.`}
            href="/accounts"
          />
          <QuickAction
            title="Open a Fiscal Period"
            description={
              currentPeriod
                ? `Current period ${currentPeriod.periodCode} is open. Close or generate the next year.`
                : "No open period for today. Generate a fiscal year to start posting."
            }
            href="/periods"
          />
          <QuickAction
            title="General Ledger"
            description="Recent journals with drill-down to detail."
            href="/gl"
          />
        </div>
      </div>
    </AppShell>
  );
}

function QuickAction({
  title,
  description,
  href,
}: {
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-border bg-card p-5 hover:border-ring transition-colors block"
    >
      <div className="font-heading text-lg tracking-[0.1em] text-foreground mb-1">
        {title.toUpperCase()}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {description}
      </p>
    </Link>
  );
}
