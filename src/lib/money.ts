import Decimal from "decimal.js";

/**
 * Money handling for Groundworks. All financial math MUST go through this
 * module — never do math with JavaScript `number` on currency values.
 *
 *   - DB column: numeric(20, 4)       — up to 4 decimal places (unit prices
 *                                       on construction line items commonly
 *                                       need 3–4)
 *   - Display precision: 2            — standard currency formatting
 *   - Internal arithmetic: Decimal    — avoids binary-float errors
 *
 * Rule of thumb: parse DB values with `money()`, do math with `.plus()` etc.,
 * persist with `.toFixed(4)`, format for humans with `formatMoney()`.
 */

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export type MoneyInput = string | number | Decimal;

export function money(value: MoneyInput = 0): Decimal {
  return new Decimal(value);
}

export function sumMoney(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(money(v)), money(0));
}

export function toDbMoney(value: MoneyInput): string {
  return money(value).toFixed(4);
}

export function formatMoney(
  value: MoneyInput,
  opts: { currency?: string; locale?: string } = {}
): string {
  const { currency = "USD", locale = "en-US" } = opts;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(money(value).toNumber());
}

export const MONEY_ZERO = money(0);
