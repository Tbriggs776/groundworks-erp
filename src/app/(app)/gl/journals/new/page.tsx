import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts, reasonCodes, sourceCodes } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { JournalEntryForm } from "./journal-entry-form";

export default async function NewJournalPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [acctRows, sourceRows, reasonRows] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, organization.id))
      .orderBy(asc(accounts.code)),
    db
      .select()
      .from(sourceCodes)
      .where(
        and(
          eq(sourceCodes.organizationId, organization.id),
          eq(sourceCodes.isActive, true)
        )
      )
      .orderBy(asc(sourceCodes.code)),
    db
      .select()
      .from(reasonCodes)
      .where(
        and(
          eq(reasonCodes.organizationId, organization.id),
          eq(reasonCodes.isActive, true)
        )
      )
      .orderBy(asc(reasonCodes.code)),
  ]);

  const gjSource = sourceRows.find((s) => s.code === "GJ") ?? sourceRows[0];
  if (!gjSource) {
    return (
      <AppShell
        title="Manual Journal Entry"
        crumb={`${organization.name} · General Ledger`}
        userEmail={user?.email}
      >
        <p className="text-sm text-muted-foreground">
          No source codes configured. Re-run onboarding seeders.
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Manual Journal Entry"
      crumb={`${organization.name} · General Ledger`}
      userEmail={user?.email}
    >
      <JournalEntryForm
        accounts={acctRows}
        sourceCodes={sourceRows}
        reasonCodes={reasonRows}
        defaultSourceCodeId={gjSource.id}
      />
    </AppShell>
  );
}
