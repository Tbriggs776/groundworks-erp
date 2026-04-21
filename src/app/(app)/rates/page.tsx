import { asc, desc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import { currencies, exchangeRates } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { NewRateButton } from "./rate-form";

export default async function RatesPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [rates, currencyRows] = await Promise.all([
    db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.organizationId, organization.id))
      .orderBy(
        asc(exchangeRates.fromCurrency),
        asc(exchangeRates.toCurrency),
        asc(exchangeRates.rateType),
        desc(exchangeRates.effectiveDate)
      ),
    db
      .select()
      .from(currencies)
      .where(eq(currencies.isActive, true))
      .orderBy(asc(currencies.code)),
  ]);

  return (
    <AppShell
      title="Exchange Rates"
      crumb={`${organization.name} · Financials`}
      userEmail={user?.email}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {rates.length} rate{rates.length === 1 ? "" : "s"} on file.
            Base currency: {organization.baseCurrency}.
          </div>
          <NewRateButton currencies={currencyRows} />
        </div>

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-20">From</th>
                <th className="text-left font-medium px-3 py-2 w-20">To</th>
                <th className="text-left font-medium px-3 py-2 w-28">Type</th>
                <th className="text-left font-medium px-3 py-2 w-32">
                  Effective
                </th>
                <th className="text-right font-medium px-3 py-2 w-40">Rate</th>
                <th className="text-right font-medium px-3 py-2 w-40">
                  Inverse
                </th>
              </tr>
            </thead>
            <tbody>
              {rates.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No exchange rates yet. Add rates for the currency pairs
                    your business uses, then revalue at period end.
                  </td>
                </tr>
              )}
              {rates.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-1.5 font-mono text-xs">
                    {r.fromCurrency}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.toCurrency}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant="secondary" className="text-[9px] capitalize">
                      {r.rateType}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                    {r.effectiveDate}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {r.rate}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                    {r.inverseRate}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
