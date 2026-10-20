import { and, asc, eq, or } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { runAs } from "@/lib/actor";
import { allOpenVendorCredits } from "@/lib/ap/credits";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { VendorRefundForm } from "../refund-form";

export default async function NewVendorRefundPage({ searchParams }: { searchParams: Promise<{ vendorId?: string; vendorCreditId?: string }> }) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor("bookkeeper");
  const open = await runAs(actor, (ctx) => allOpenVendorCredits(ctx));
  const creditsByVendor: Record<string, Array<{ id: string; number: string; remaining: string }>> = {};
  const vendors = new Map<string, { id: string; name: string; currency: string }>();
  for (const c of open) {
    (creditsByVendor[c.vendorId] ??= []).push({ id: c.id, number: c.number, remaining: c.remaining });
    vendors.set(c.vendorId, { id: c.vendorId, name: c.vendorName, currency: c.currency });
  }
  const bankRows = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organization.id),
        eq(accounts.accountType, "posting"),
        eq(accounts.isActive, true),
        or(eq(accounts.isCash, true), eq(accounts.isReconciliation, true))
      )
    )
    .orderBy(asc(accounts.code));
  return (
    <AppShell title="New Vendor Refund" crumb={`${organization.name} · Expenses`} userEmail={user?.email}>
      <VendorRefundForm
        vendors={[...vendors.values()].sort((a, b) => a.name.localeCompare(b.name))}
        creditsByVendor={creditsByVendor}
        accounts={bankRows}
        defaults={{ vendorId: sp.vendorId, vendorCreditId: sp.vendorCreditId }}
      />
    </AppShell>
  );
}
