import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  recurringJournalLines,
  recurringJournals,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { RecurringForm } from "../recurring-form";

export default async function EditRecurringPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [rec] = await db
    .select()
    .from(recurringJournals)
    .where(
      and(
        eq(recurringJournals.id, id),
        eq(recurringJournals.organizationId, organization.id)
      )
    );
  if (!rec) notFound();

  const [lineRows, acctRows] = await Promise.all([
    db
      .select()
      .from(recurringJournalLines)
      .where(eq(recurringJournalLines.recurringJournalId, id))
      .orderBy(asc(recurringJournalLines.lineNumber)),
    db
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, organization.id))
      .orderBy(asc(accounts.code)),
  ]);

  return (
    <AppShell
      title={`Edit ${rec.code}`}
      crumb={`${organization.name} · Financials · Recurring`}
      userEmail={user?.email}
    >
      <RecurringForm
        accounts={acctRows}
        initial={{
          id: rec.id,
          code: rec.code,
          name: rec.name,
          description: rec.description,
          journalDescription: rec.journalDescription,
          frequency: rec.frequency,
          startDate: rec.startDate,
          endDate: rec.endDate,
          nextRunDate: rec.nextRunDate,
          currency: rec.currency,
          status: rec.status,
          lines: lineRows.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            memo: l.memo,
          })),
        }}
      />
    </AppShell>
  );
}
