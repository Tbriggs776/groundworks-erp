import { format, startOfYear } from "date-fns";
import { z } from "zod";
import { requirePermission, type Ctx } from "@/lib/actor";
import {
  getBalanceSheet,
  getGlDetail,
  getIncomeStatement,
  getTrialBalance,
} from "@/lib/gl/reports";
import { flag, id, isoDate } from "@/lib/schemas";

/**
 * Financial statements as services. Thin permission-checked wrappers over
 * src/lib/gl/reports.ts; Decimal values serialize to strings in JSON.
 */

const today = () => format(new Date(), "yyyy-MM-dd");

export const AsOfSchema = z.object({
  asOf: isoDate.optional().describe("Report date. Defaults to today."),
});

export const TrialBalanceSchema = AsOfSchema.extend({
  includeZero: flag.optional().describe("Include accounts with no activity."),
});

export const RangeSchema = z.object({
  from: isoDate.optional().describe("Start date (inclusive). Defaults to Jan 1 of this year."),
  to: isoDate.optional().describe("End date (inclusive). Defaults to today."),
});

export const AccountLedgerSchema = RangeSchema.extend({
  accountId: id,
});

export async function trialBalance(ctx: Ctx, input: z.input<typeof TrialBalanceSchema> = {}) {
  requirePermission(ctx.actor, "read", "viewer", "run the trial balance");
  const f = TrialBalanceSchema.parse(input);
  const asOfDate = f.asOf ?? today();
  const rows = await getTrialBalance(ctx.actor.organizationId, {
    asOfDate,
    includeZero: f.includeZero,
  });
  return { asOf: asOfDate, rows };
}

export async function balanceSheet(ctx: Ctx, input: z.input<typeof AsOfSchema> = {}) {
  requirePermission(ctx.actor, "read", "viewer", "run the balance sheet");
  const asOfDate = AsOfSchema.parse(input).asOf ?? today();
  return getBalanceSheet(ctx.actor.organizationId, asOfDate);
}

export async function profitAndLoss(ctx: Ctx, input: z.input<typeof RangeSchema> = {}) {
  requirePermission(ctx.actor, "read", "viewer", "run the profit and loss");
  const f = RangeSchema.parse(input);
  return getIncomeStatement(ctx.actor.organizationId, {
    fromDate: f.from ?? format(startOfYear(new Date()), "yyyy-MM-dd"),
    toDate: f.to ?? today(),
  });
}

export async function accountLedger(ctx: Ctx, input: z.input<typeof AccountLedgerSchema>) {
  requirePermission(ctx.actor, "read", "viewer", "run an account ledger");
  const f = AccountLedgerSchema.parse(input);
  return getGlDetail(ctx.actor.organizationId, {
    accountId: f.accountId,
    fromDate: f.from ?? format(startOfYear(new Date()), "yyyy-MM-dd"),
    toDate: f.to ?? today(),
  });
}
