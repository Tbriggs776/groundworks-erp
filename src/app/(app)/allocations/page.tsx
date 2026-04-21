import Link from "next/link";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  allocationGroups,
  allocationTargets,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { AllocationsListClient } from "./allocations-list-client";

export default async function AllocationsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [groups, targetCounts, acctRows] = await Promise.all([
    db
      .select()
      .from(allocationGroups)
      .where(
        and(
          eq(allocationGroups.organizationId, organization.id),
          isNull(allocationGroups.deletedAt)
        )
      )
      .orderBy(desc(allocationGroups.updatedAt)),
    db
      .select({
        groupId: allocationTargets.allocationGroupId,
        n: sql<number>`count(*)::int`,
      })
      .from(allocationTargets)
      .where(eq(allocationTargets.organizationId, organization.id))
      .groupBy(allocationTargets.allocationGroupId),
    db
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, organization.id))
      .orderBy(asc(accounts.code)),
  ]);

  const countById = new Map(targetCounts.map((r) => [r.groupId, r.n]));
  const groupsWithCount = groups.map((g) => ({
    ...g,
    targetCount: countById.get(g.id) ?? 0,
  }));

  return (
    <AppShell
      title="Allocations"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Allocation rules that spread an amount across multiple accounts.
            Run one from this page to post a balanced JE.
          </div>
          <Link
            href="/allocations/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New allocation
          </Link>
        </div>

        <AllocationsListClient groups={groupsWithCount} accounts={acctRows} />
      </div>
    </AppShell>
  );
}
