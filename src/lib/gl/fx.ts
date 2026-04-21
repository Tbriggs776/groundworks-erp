import { and, desc, eq, lte, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/lib/db/client";
import { exchangeRates, exchangeRateType } from "@/lib/db/schema";
import { money } from "@/lib/money";

/**
 * Exchange rate helpers. Rates are stored with a high-precision numeric
 * (20,10) and an explicit `inverseRate`. Lookups pick the most recent
 * effective_date <= asOfDate for the (from, to, type) triple.
 *
 * Convention: `rate` = units of `toCurrency` per 1 unit of `fromCurrency`.
 *   USD -> EUR at 0.92 means "1 USD = 0.92 EUR".
 *   To convert 100 USD to EUR: 100 * 0.92 = 92.
 *   To convert 92 EUR back to USD: 92 * inverseRate (≈ 1.0869565...).
 */

type ExchangeRateTypeValue = (typeof exchangeRateType.enumValues)[number];

export type EffectiveRate = {
  rate: Decimal;
  inverseRate: Decimal;
  effectiveDate: string;
};

/**
 * Look up the effective rate on `asOfDate`. Falls back to looking in the
 * opposite direction (using the inverse) if no direct rate exists — useful
 * for orgs that only maintain one side of each pair.
 *
 * Returns null if no rate exists for either direction. Callers should
 * surface a clear error rather than silently treating as 1.0.
 */
export async function getEffectiveRate(
  organizationId: string,
  fromCurrency: string,
  toCurrency: string,
  rateType: ExchangeRateTypeValue,
  asOfDate: string
): Promise<EffectiveRate | null> {
  if (fromCurrency === toCurrency) {
    return { rate: money(1), inverseRate: money(1), effectiveDate: asOfDate };
  }

  // Direct direction
  const [direct] = await db
    .select({
      rate: exchangeRates.rate,
      inverseRate: exchangeRates.inverseRate,
      effectiveDate: exchangeRates.effectiveDate,
    })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.organizationId, organizationId),
        eq(exchangeRates.fromCurrency, fromCurrency),
        eq(exchangeRates.toCurrency, toCurrency),
        eq(exchangeRates.rateType, rateType),
        lte(exchangeRates.effectiveDate, asOfDate)
      )
    )
    .orderBy(desc(exchangeRates.effectiveDate))
    .limit(1);
  if (direct) {
    return {
      rate: money(direct.rate),
      inverseRate: money(direct.inverseRate),
      effectiveDate: direct.effectiveDate,
    };
  }

  // Inverse direction (invert the rate)
  const [inverse] = await db
    .select({
      rate: exchangeRates.rate,
      inverseRate: exchangeRates.inverseRate,
      effectiveDate: exchangeRates.effectiveDate,
    })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.organizationId, organizationId),
        eq(exchangeRates.fromCurrency, toCurrency),
        eq(exchangeRates.toCurrency, fromCurrency),
        eq(exchangeRates.rateType, rateType),
        lte(exchangeRates.effectiveDate, asOfDate)
      )
    )
    .orderBy(desc(exchangeRates.effectiveDate))
    .limit(1);
  if (inverse) {
    return {
      rate: money(inverse.inverseRate),
      inverseRate: money(inverse.rate),
      effectiveDate: inverse.effectiveDate,
    };
  }

  return null;
}

/**
 * Convenience: convert an amount from one currency to another using the
 * effective spot rate on `asOfDate`. Returns a Decimal for downstream math;
 * caller should format with `formatMoney`.
 *
 * Throws if no rate is available — silently defaulting to 1.0 would
 * quietly corrupt financial math.
 */
export async function convertAmount(
  organizationId: string,
  amount: string | Decimal,
  fromCurrency: string,
  toCurrency: string,
  asOfDate: string,
  rateType: ExchangeRateTypeValue = "spot"
): Promise<Decimal> {
  const rate = await getEffectiveRate(
    organizationId,
    fromCurrency,
    toCurrency,
    rateType,
    asOfDate
  );
  if (!rate) {
    throw new Error(
      `No ${rateType} rate found for ${fromCurrency}->${toCurrency} as of ${asOfDate}.`
    );
  }
  return money(amount).mul(rate.rate);
}

/**
 * List the currencies an organization holds open balances in, as of the
 * given date. Used to drive the revaluation run — we only need rates for
 * these currencies.
 */
export async function foreignCurrenciesWithActivity(
  organizationId: string,
  baseCurrency: string,
  asOfDate: string
): Promise<string[]> {
  const rows = await db.execute<{ currency: string }>(sql`
    SELECT DISTINCT j.currency
      FROM public.gl_journals j
     WHERE j.organization_id = ${organizationId}
       AND j.status = 'posted'
       AND j.journal_date <= ${asOfDate}::date
       AND j.currency <> ${baseCurrency}
  `);
  return rows.map((r) => r.currency);
}
