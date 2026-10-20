import { endOfQuarter, format, startOfQuarter, startOfYear, subQuarters } from "date-fns";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listBankingAccounts } from "@/lib/banking/transactions";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { listTaxPayments, salesTaxLiability } from "@/lib/sales-tax/liability";
import { listTaxAgencies, listTaxRates } from "@/lib/sales-tax/rates";
import { SalesTaxClient } from "./sales-tax-client";

const d = (x: Date) => format(x, "yyyy-MM-dd");

export default async function SalesTaxPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; period?: string }> }) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const now = new Date();
  const presets = {
    this_quarter: { from: d(startOfQuarter(now)), to: d(now) },
    last_quarter: { from: d(startOfQuarter(subQuarters(now, 1))), to: d(endOfQuarter(subQuarters(now, 1))) },
    this_year: { from: d(startOfYear(now)), to: d(now) },
  };
  const period = sp.from && sp.to ? { from: sp.from, to: sp.to } : presets[(sp.period as keyof typeof presets) ?? "this_quarter"] ?? presets.this_quarter;

  const [report, agencies, rates, payments, banks, liabilities] = await Promise.all([
    runAs(actor, (ctx) => salesTaxLiability(ctx, period)),
    runAs(actor, (ctx) => listTaxAgencies(ctx, { includeInactive: true })),
    runAs(actor, (ctx) => listTaxRates(ctx, { includeInactive: true })),
    runAs(actor, (ctx) => listTaxPayments(ctx, { limit: 50 })),
    runAs(actor, (ctx) => listBankingAccounts(ctx)),
    db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          eq(accounts.category, "balance_sheet"),
          eq(accounts.normalBalance, "credit"),
          eq(accounts.accountType, "posting"),
          eq(accounts.isActive, true),
          eq(accounts.isControl, false)
        )
      )
      .orderBy(asc(accounts.code)),
  ]);

  return (
    <AppShell title="Sales Tax" crumb={`${organization.name} · Sales`} userEmail={user?.email}>
      <SalesTaxClient
        currency={organization.baseCurrency}
        period={period}
        presets={presets}
        report={report}
        agencies={agencies}
        rates={rates}
        payments={payments.data}
        bankAccounts={banks.map((b) => ({ id: b.id, code: b.code, name: b.name }))}
        liabilityAccounts={liabilities}
      />
    </AppShell>
  );
}
