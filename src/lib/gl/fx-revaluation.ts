import { and, eq, lte, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/lib/db/client";
import {
  accounts,
  glJournals,
  glLines,
  organizations,
  type Account,
} from "@/lib/db/schema";
import { money, sumMoney } from "@/lib/money";
import { createAndPostJournal, type PostResult } from "./posting";
import { foreignCurrenciesWithActivity, getEffectiveRate } from "./fx";

/**
 * Period-end FX revaluation. For each account that carries a foreign-
 * currency balance (journal.currency <> org.base_currency), re-translates
 * the foreign balance at the spot rate as-of the revaluation date and
 * posts a balanced adjusting JE booking the difference to unrealized FX
 * gain/loss accounts.
 *
 * Adjustments are computed per (account, currency) — a single account
 * holding balances in multiple foreign currencies gets one adjustment row
 * per currency.
 *
 * The posted revaluation JE typically auto-reverses on day 1 of the next
 * period so that the period-specific unrealized gain/loss doesn't persist
 * into the following period's actuals. The caller supplies the
 * auto_reverse_date (or omits it, if they want a permanent revaluation).
 *
 * This is GL-LEVEL revaluation only — AR/AP open-item revaluation will
 * layer on top when those subledgers land and can use the same rate
 * infrastructure (src/lib/gl/fx.ts::getEffectiveRate).
 */

export type FxAdjustment = {
  accountId: string;
  accountCode: string;
  accountName: string;
  normalBalance: Account["normalBalance"];
  currency: string;
  foreignBalance: Decimal;
  bookLocalBalance: Decimal;
  currentRate: Decimal;
  rateEffectiveDate: string;
  newLocalValue: Decimal;
  /** Positive → debit the account, Negative → credit the account. */
  adjustment: Decimal;
};

export type FxAdjustmentSummary = {
  baseCurrency: string;
  asOfDate: string;
  adjustments: FxAdjustment[];
  netAdjustment: Decimal;
  missingRates: Array<{ fromCurrency: string; toCurrency: string }>;
};

/**
 * Compute adjustments WITHOUT posting. Used by the UI to preview the
 * revaluation impact and to detect missing exchange rates before asking
 * the user to commit.
 */
export async function computeFxAdjustments(
  organizationId: string,
  asOfDate: string
): Promise<FxAdjustmentSummary> {
  const [org] = await db
    .select({ baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!org) throw new Error("Organization not found.");
  const baseCurrency = org.baseCurrency;

  const currencies = await foreignCurrenciesWithActivity(
    organizationId,
    baseCurrency,
    asOfDate
  );
  if (currencies.length === 0) {
    return {
      baseCurrency,
      asOfDate,
      adjustments: [],
      netAdjustment: money(0),
      missingRates: [],
    };
  }

  // Aggregate foreign + local balances per (account, currency)
  // Only posted journals through asOfDate.
  const rows = await db
    .select({
      accountId: glLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      normalBalance: accounts.normalBalance,
      currency: glJournals.currency,
      foreignDebit: sql<string>`COALESCE(SUM(${glLines.debit}), 0)::text`,
      foreignCredit: sql<string>`COALESCE(SUM(${glLines.credit}), 0)::text`,
      localDebit: sql<string>`COALESCE(SUM(${glLines.debitLocal}), 0)::text`,
      localCredit: sql<string>`COALESCE(SUM(${glLines.creditLocal}), 0)::text`,
    })
    .from(glLines)
    .innerJoin(glJournals, eq(glJournals.id, glLines.journalId))
    .innerJoin(accounts, eq(accounts.id, glLines.accountId))
    .where(
      and(
        eq(glLines.organizationId, organizationId),
        eq(glJournals.status, "posted"),
        lte(glJournals.journalDate, asOfDate),
        sql`${glJournals.currency} <> ${baseCurrency}`
      )
    )
    .groupBy(
      glLines.accountId,
      accounts.code,
      accounts.name,
      accounts.normalBalance,
      glJournals.currency
    );

  const adjustments: FxAdjustment[] = [];
  const missingRates: Array<{ fromCurrency: string; toCurrency: string }> = [];

  for (const r of rows) {
    const foreignBalance = money(r.foreignDebit).minus(money(r.foreignCredit));
    const bookLocalBalance = money(r.localDebit).minus(money(r.localCredit));

    if (foreignBalance.isZero()) continue; // nothing to revalue

    const rate = await getEffectiveRate(
      organizationId,
      r.currency,
      baseCurrency,
      "spot",
      asOfDate
    );
    if (!rate) {
      missingRates.push({ fromCurrency: r.currency, toCurrency: baseCurrency });
      continue;
    }

    const newLocalValue = foreignBalance.mul(rate.rate);
    // Round to 4 decimal places for DB numeric(20,4)
    const adjustment = money(
      newLocalValue.minus(bookLocalBalance).toFixed(4)
    );

    if (adjustment.isZero()) continue;

    adjustments.push({
      accountId: r.accountId,
      accountCode: r.accountCode,
      accountName: r.accountName,
      normalBalance: r.normalBalance,
      currency: r.currency,
      foreignBalance,
      bookLocalBalance,
      currentRate: rate.rate,
      rateEffectiveDate: rate.effectiveDate,
      newLocalValue: money(newLocalValue.toFixed(4)),
      adjustment,
    });
  }

  const netAdjustment = sumMoney(adjustments.map((a) => a.adjustment));

  return {
    baseCurrency,
    asOfDate,
    adjustments,
    netAdjustment,
    missingRates,
  };
}

export type RunFxRevaluationInput = {
  organizationId: string;
  actorId: string | null;
  asOfDate: string;
  fxGainAccountId: string;
  fxLossAccountId: string;
  sourceCodeId: string;
  autoReverseDate?: string; // ISO date; typically first of next period
  reasonCodeId?: string;
  description?: string;
};

export type RevaluationResult =
  | {
      ok: true;
      journalId: string;
      journalNumber: string;
      summary: FxAdjustmentSummary;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      summary?: FxAdjustmentSummary;
    };

/**
 * Compute adjustments and post them as a single balanced JE in the org's
 * base currency. `auto_reverse_date` is set so the adjustment unwinds on
 * day 1 of the next period (conventional for unrealized revaluation).
 *
 * Preconditions checked:
 *   - All required spot rates are on file
 *   - At least one non-zero adjustment
 *   - Gain/loss accounts are active posting accounts
 */
export async function runFxRevaluation(
  input: RunFxRevaluationInput
): Promise<RevaluationResult> {
  const summary = await computeFxAdjustments(
    input.organizationId,
    input.asOfDate
  );

  if (summary.missingRates.length > 0) {
    const missing = summary.missingRates
      .map((m) => `${m.fromCurrency}→${m.toCurrency}`)
      .join(", ");
    return {
      ok: false,
      code: "missing_rates",
      error: `Missing spot rate(s) as of ${input.asOfDate}: ${missing}. Add rates on the Exchange Rates screen.`,
      summary,
    };
  }

  if (summary.adjustments.length === 0) {
    return {
      ok: false,
      code: "no_adjustments",
      error:
        "No non-zero FX adjustments to post. Nothing changed since the last revaluation.",
      summary,
    };
  }

  // Build JE lines
  const lines: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    memo?: string;
  }> = [];

  for (const a of summary.adjustments) {
    const abs = a.adjustment.abs().toFixed(4);
    const side = a.adjustment.gt(0) ? "debit" : "credit";
    lines.push({
      accountId: a.accountId,
      [side]: abs,
      memo: `FX reval ${a.currency} @ ${a.currentRate.toFixed(6)} — ${a.foreignBalance.toFixed(2)} ${a.currency} → ${a.newLocalValue.toFixed(2)} ${summary.baseCurrency}`,
    });
  }

  const net = summary.netAdjustment;
  if (!net.isZero()) {
    const abs = net.abs().toFixed(4);
    if (net.gt(0)) {
      // Net gain: credit the gain account (total debits > total credits
      // on the account lines above → offset with a credit)
      lines.push({
        accountId: input.fxGainAccountId,
        credit: abs,
        memo: `Unrealized FX gain`,
      });
    } else {
      // Net loss: debit the loss account
      lines.push({
        accountId: input.fxLossAccountId,
        debit: abs,
        memo: `Unrealized FX loss`,
      });
    }
  }

  const result: PostResult = await createAndPostJournal({
    organizationId: input.organizationId,
    actorId: input.actorId,
    journalDate: input.asOfDate,
    sourceCodeId: input.sourceCodeId,
    source: "adjusting",
    description:
      input.description ?? `FX revaluation as of ${input.asOfDate}`,
    reasonCodeId: input.reasonCodeId,
    currency: summary.baseCurrency,
    exchangeRate: "1",
    lines,
    autoReverseDate: input.autoReverseDate,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code, summary };
  }

  return {
    ok: true,
    journalId: result.journalId,
    journalNumber: result.journalNumber,
    summary,
  };
}
