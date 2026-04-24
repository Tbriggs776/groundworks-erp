import { asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { approvalThresholds } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { ThresholdsClient } from "./thresholds-client";

export default async function ApprovalThresholdsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select()
    .from(approvalThresholds)
    .where(eq(approvalThresholds.organizationId, organization.id))
    .orderBy(
      asc(approvalThresholds.scope),
      asc(approvalThresholds.sortOrder),
      asc(approvalThresholds.minAmount)
    );

  return (
    <AppShell
      title="Approval Thresholds"
      crumb={`${organization.name} · Settings`}
      userEmail={user?.email}
    >
      <ThresholdsClient thresholds={rows} />
    </AppShell>
  );
}
