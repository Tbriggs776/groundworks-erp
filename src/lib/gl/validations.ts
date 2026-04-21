import { and, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/lib/db/client";
import {
  accountDefaultDimensions,
  accounts,
  dimensionCombinations,
  fiscalPeriods,
  glJournals,
  glLineDimensions,
  glLines,
  organizations,
  postingDateRestrictions,
} from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { money, sumMoney } from "@/lib/money";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A failed validation: code is stable for UI mapping, message is human-readable.
 * Successful runs return { ok: true }.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string; meta?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Individual validators — each does ONE check. Called in sequence by
// `validateJournalForPost`. Kept small so they can be unit-tested.
// ---------------------------------------------------------------------------

/**
 * 1. Journal must be in draft status (or pending_approval, if approval
 *    workflow is active) — never post twice.
 */
export async function v1JournalIsDraft(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const [j] = await tx
    .select({ id: glJournals.id, status: glJournals.status })
    .from(glJournals)
    .where(eq(glJournals.id, journalId));
  if (!j) {
    return { ok: false, code: "journal_not_found", message: "Journal not found." };
  }
  if (j.status !== "draft" && j.status !== "pending_approval") {
    return {
      ok: false,
      code: "journal_not_draft",
      message: `Journal is "${j.status}", expected draft.`,
    };
  }
  return { ok: true };
}

/**
 * 2. All referenced accounts exist, are active, and not blocked.
 */
export async function v2AccountsActive(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const lines = await tx
    .select({ id: glLines.id, accountId: glLines.accountId })
    .from(glLines)
    .where(eq(glLines.journalId, journalId));

  if (lines.length === 0) {
    return {
      ok: false,
      code: "no_lines",
      message: "Journal has no lines.",
    };
  }

  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accts = await tx
    .select({
      id: accounts.id,
      isActive: accounts.isActive,
      isBlocked: accounts.isBlocked,
      accountType: accounts.accountType,
      code: accounts.code,
      name: accounts.name,
    })
    .from(accounts)
    .where(inArray(accounts.id, accountIds));

  const byId = new Map(accts.map((a) => [a.id, a]));
  for (const l of lines) {
    const a = byId.get(l.accountId);
    if (!a) {
      return {
        ok: false,
        code: "account_missing",
        message: "A line references a non-existent account.",
        meta: { accountId: l.accountId },
      };
    }
    if (a.accountType !== "posting") {
      return {
        ok: false,
        code: "account_not_posting",
        message: `Account ${a.code} (${a.name}) is a ${a.accountType} account, not a posting account.`,
        meta: { accountCode: a.code },
      };
    }
    if (!a.isActive) {
      return {
        ok: false,
        code: "account_inactive",
        message: `Account ${a.code} (${a.name}) is inactive.`,
        meta: { accountCode: a.code },
      };
    }
    if (a.isBlocked) {
      return {
        ok: false,
        code: "account_blocked",
        message: `Account ${a.code} (${a.name}) is blocked from new posting.`,
        meta: { accountCode: a.code },
      };
    }
  }
  return { ok: true };
}

const SUBLEDGER_SOURCES = new Set([
  "ap",
  "ar",
  "cash_receipt",
  "cash_disbursement",
  "payroll",
  "inventory",
  "fixed_asset",
]);

/**
 * 3. `direct_posting=false` accounts (control accounts) can only be posted to
 *    from their subledger source. Manual GJs can't touch them.
 */
export async function v3DirectPostingRule(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const [j] = await tx
    .select({ source: glJournals.source })
    .from(glJournals)
    .where(eq(glJournals.id, journalId));
  if (!j) return { ok: false, code: "journal_not_found", message: "Journal not found." };

  const rows = await tx
    .select({
      accountId: accounts.id,
      directPosting: accounts.directPosting,
      code: accounts.code,
      name: accounts.name,
    })
    .from(glLines)
    .innerJoin(accounts, eq(accounts.id, glLines.accountId))
    .where(eq(glLines.journalId, journalId));

  const isSubledgerSourced = SUBLEDGER_SOURCES.has(j.source);
  for (const r of rows) {
    if (!r.directPosting && !isSubledgerSourced) {
      return {
        ok: false,
        code: "control_account_manual",
        message: `Account ${r.code} (${r.name}) is a control account and can only be posted to from its subledger (AP/AR/inventory/...).`,
        meta: { accountCode: r.code, source: j.source },
      };
    }
  }
  return { ok: true };
}

/**
 * 4. `debit_credit_enforced` on the account restricts which side of the entry
 *    may carry a non-zero amount.
 */
export async function v4DebitCreditEnforced(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const rows = await tx
    .select({
      lineNumber: glLines.lineNumber,
      debit: glLines.debit,
      credit: glLines.credit,
      enforced: accounts.debitCreditEnforced,
      code: accounts.code,
    })
    .from(glLines)
    .innerJoin(accounts, eq(accounts.id, glLines.accountId))
    .where(eq(glLines.journalId, journalId));

  for (const r of rows) {
    const dbt = money(r.debit);
    const crd = money(r.credit);
    if (r.enforced === "debit_only" && crd.gt(0)) {
      return {
        ok: false,
        code: "debit_only_violated",
        message: `Account ${r.code} is debit-only; line ${r.lineNumber} has a credit.`,
      };
    }
    if (r.enforced === "credit_only" && dbt.gt(0)) {
      return {
        ok: false,
        code: "credit_only_violated",
        message: `Account ${r.code} is credit-only; line ${r.lineNumber} has a debit.`,
      };
    }
  }
  return { ok: true };
}

/**
 * 5. Required dimensions per `account_default_dimensions.value_posting` are
 *    populated.
 */
export async function v5RequiredDimensions(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const required = await tx
    .select({
      accountId: accountDefaultDimensions.accountId,
      dimensionId: accountDefaultDimensions.dimensionId,
      defaultValueId: accountDefaultDimensions.defaultValueId,
      valuePosting: accountDefaultDimensions.valuePosting,
      accountCode: accounts.code,
    })
    .from(accountDefaultDimensions)
    .innerJoin(accounts, eq(accounts.id, accountDefaultDimensions.accountId))
    .innerJoin(
      glLines,
      eq(glLines.accountId, accountDefaultDimensions.accountId)
    )
    .where(eq(glLines.journalId, journalId));

  const present = await tx
    .select({
      lineId: glLineDimensions.lineId,
      accountId: glLines.accountId,
      dimensionId: glLineDimensions.dimensionId,
      valueId: glLineDimensions.valueId,
    })
    .from(glLineDimensions)
    .innerJoin(glLines, eq(glLines.id, glLineDimensions.lineId))
    .where(eq(glLines.journalId, journalId));

  const lines = await tx
    .select({ id: glLines.id, accountId: glLines.accountId })
    .from(glLines)
    .where(eq(glLines.journalId, journalId));

  for (const line of lines) {
    for (const rule of required.filter((r) => r.accountId === line.accountId)) {
      if (rule.valuePosting === "no_code") continue;
      const match = present.find(
        (p) => p.lineId === line.id && p.dimensionId === rule.dimensionId
      );
      if (rule.valuePosting === "code_mandatory" && !match) {
        return {
          ok: false,
          code: "dimension_required",
          message: `Account ${rule.accountCode} requires a value for dimension on every posting line.`,
        };
      }
      if (
        rule.valuePosting === "same_code" ||
        rule.valuePosting === "same_code_and_same_value"
      ) {
        if (!match) {
          return {
            ok: false,
            code: "dimension_required",
            message: `Account ${rule.accountCode} requires a matching default dimension value.`,
          };
        }
        if (
          rule.defaultValueId &&
          match.valueId !== rule.defaultValueId
        ) {
          return {
            ok: false,
            code: "dimension_value_mismatch",
            message: `Account ${rule.accountCode} requires dimension value to match the configured default.`,
          };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * 6. No line's dimension pair is in the `blocked` list.
 */
export async function v6DimensionCombinations(
  tx: Tx,
  journalId: string,
  organizationId: string
): Promise<ValidationResult> {
  const blocked = await tx
    .select({
      dim1: dimensionCombinations.dimension1Id,
      val1: dimensionCombinations.value1Id,
      dim2: dimensionCombinations.dimension2Id,
      val2: dimensionCombinations.value2Id,
    })
    .from(dimensionCombinations)
    .where(
      and(
        eq(dimensionCombinations.organizationId, organizationId),
        eq(dimensionCombinations.combination, "blocked")
      )
    );
  if (blocked.length === 0) return { ok: true };

  const lineDims = await tx
    .select({
      lineId: glLineDimensions.lineId,
      dimensionId: glLineDimensions.dimensionId,
      valueId: glLineDimensions.valueId,
    })
    .from(glLineDimensions)
    .innerJoin(glLines, eq(glLines.id, glLineDimensions.lineId))
    .where(eq(glLines.journalId, journalId));

  // Group by line
  const byLine = new Map<
    string,
    Array<{ dimensionId: string; valueId: string }>
  >();
  for (const d of lineDims) {
    const arr = byLine.get(d.lineId) ?? [];
    arr.push({ dimensionId: d.dimensionId, valueId: d.valueId });
    byLine.set(d.lineId, arr);
  }

  for (const [lineId, dims] of byLine) {
    for (let i = 0; i < dims.length; i++) {
      for (let j = i + 1; j < dims.length; j++) {
        const a = dims[i];
        const b = dims[j];
        const hit = blocked.find(
          (rule) =>
            (rule.dim1 === a.dimensionId &&
              rule.val1 === a.valueId &&
              rule.dim2 === b.dimensionId &&
              rule.val2 === b.valueId) ||
            (rule.dim1 === b.dimensionId &&
              rule.val1 === b.valueId &&
              rule.dim2 === a.dimensionId &&
              rule.val2 === a.valueId)
        );
        if (hit) {
          return {
            ok: false,
            code: "dimension_combination_blocked",
            message:
              "One of the lines uses a dimension combination flagged as blocked.",
            meta: { lineId },
          };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * 7. sum(debit) === sum(credit) in journal currency.
 */
export async function v7BalanceInJournalCurrency(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const rows = await tx
    .select({ debit: glLines.debit, credit: glLines.credit })
    .from(glLines)
    .where(eq(glLines.journalId, journalId));

  const totDr = sumMoney(rows.map((r) => r.debit));
  const totCr = sumMoney(rows.map((r) => r.credit));
  if (!totDr.eq(totCr)) {
    return {
      ok: false,
      code: "unbalanced_currency",
      message: `Debits (${totDr.toFixed(
        2
      )}) and credits (${totCr.toFixed(2)}) do not balance.`,
      meta: { debits: totDr.toString(), credits: totCr.toString() },
    };
  }
  return { ok: true };
}

/**
 * 8. sum(debit_local) === sum(credit_local).
 */
export async function v8BalanceInLocalCurrency(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const rows = await tx
    .select({
      debitLocal: glLines.debitLocal,
      creditLocal: glLines.creditLocal,
    })
    .from(glLines)
    .where(eq(glLines.journalId, journalId));

  const totDr = sumMoney(rows.map((r) => r.debitLocal));
  const totCr = sumMoney(rows.map((r) => r.creditLocal));
  if (!totDr.eq(totCr)) {
    return {
      ok: false,
      code: "unbalanced_local",
      message: `Local-currency debits (${totDr.toFixed(
        2
      )}) and credits (${totCr.toFixed(2)}) do not balance.`,
    };
  }
  return { ok: true };
}

/**
 * 9. Period status allows posting. `hard_closed` requires override.
 *    Returns { ok: true } and signals caller whether override is needed
 *    via the meta field.
 */
export async function v9PeriodStatus(
  tx: Tx,
  journalId: string,
  opts: { overridePassword?: string; overrideReason?: string }
): Promise<ValidationResult & { needsOverride?: boolean }> {
  const [row] = await tx
    .select({
      source: glJournals.source,
      periodStatus: fiscalPeriods.status,
      organizationId: glJournals.organizationId,
      periodId: glJournals.periodId,
    })
    .from(glJournals)
    .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, glJournals.periodId))
    .where(eq(glJournals.id, journalId));
  if (!row)
    return { ok: false, code: "journal_not_found", message: "Journal not found." };

  if (row.periodStatus === "open") return { ok: true };

  if (row.periodStatus === "soft_closed") {
    if (row.source === "adjusting" || row.source === "reversing") {
      return { ok: true };
    }
    return {
      ok: false,
      code: "period_soft_closed",
      message:
        "Period is soft-closed. Only adjusting or reversing entries may post.",
    };
  }

  // hard_closed — check override
  const [org] = await tx
    .select({
      hash: organizations.hardCloseOverridePasswordHash,
      requireReason: organizations.requireReasonForOverride,
    })
    .from(organizations)
    .where(eq(organizations.id, row.organizationId));

  if (!org || !org.hash) {
    return {
      ok: false,
      code: "period_hard_closed_no_override",
      message:
        "Period is hard-closed and no override password is configured for this organization.",
    };
  }
  if (!opts.overridePassword) {
    return {
      ok: false,
      code: "period_hard_closed_override_required",
      message: "Period is hard-closed. Override password required to post.",
      needsOverride: true,
    };
  }
  const valid = await verifyPassword(opts.overridePassword, org.hash);
  if (!valid) {
    return {
      ok: false,
      code: "override_password_invalid",
      message: "Override password is incorrect.",
    };
  }
  if (org.requireReason && !opts.overrideReason?.trim()) {
    return {
      ok: false,
      code: "override_reason_required",
      message: "Override reason is required for posts to hard-closed periods.",
    };
  }
  return { ok: true };
}

/**
 * 10. User's posting_date_restrictions (if any) allow the journal_date.
 */
export async function v10UserPostingWindow(
  tx: Tx,
  journalId: string,
  actorId: string | null,
  organizationId: string
): Promise<ValidationResult> {
  // System-triggered posts (cron/recurring/auto-reverse) bypass user window
  // restrictions — the underlying recurring_journal already passed through a
  // human-authored approval when it was created.
  if (!actorId) return { ok: true };

  const [j] = await tx
    .select({ journalDate: glJournals.journalDate })
    .from(glJournals)
    .where(eq(glJournals.id, journalId));
  if (!j)
    return { ok: false, code: "journal_not_found", message: "Journal not found." };

  const [restriction] = await tx
    .select({
      from: postingDateRestrictions.allowPostFrom,
      to: postingDateRestrictions.allowPostTo,
    })
    .from(postingDateRestrictions)
    .where(
      and(
        eq(postingDateRestrictions.userId, actorId),
        eq(postingDateRestrictions.organizationId, organizationId)
      )
    );
  if (!restriction) return { ok: true }; // No restriction = unrestricted

  const date = j.journalDate;
  if (restriction.from && date < restriction.from) {
    return {
      ok: false,
      code: "posting_date_out_of_window",
      message: `You can only post journals dated ${restriction.from} or later.`,
    };
  }
  if (restriction.to && date > restriction.to) {
    return {
      ok: false,
      code: "posting_date_out_of_window",
      message: `You can only post journals dated ${restriction.to} or earlier.`,
    };
  }
  return { ok: true };
}

/**
 * 11. If this journal reverses another, the original must exist, be posted,
 *     and not already reversed.
 */
export async function v11ReversalIntegrity(
  tx: Tx,
  journalId: string
): Promise<ValidationResult> {
  const [j] = await tx
    .select({
      reversesJournalId: glJournals.reversesJournalId,
    })
    .from(glJournals)
    .where(eq(glJournals.id, journalId));
  if (!j || !j.reversesJournalId) return { ok: true };

  const [orig] = await tx
    .select({
      status: glJournals.status,
      reversedBy: glJournals.reversedByJournalId,
    })
    .from(glJournals)
    .where(eq(glJournals.id, j.reversesJournalId));
  if (!orig) {
    return {
      ok: false,
      code: "reversal_target_missing",
      message: "Reversal target journal not found.",
    };
  }
  if (orig.status !== "posted") {
    return {
      ok: false,
      code: "reversal_target_not_posted",
      message: "Cannot reverse a journal that is not in posted status.",
    };
  }
  if (orig.reversedBy) {
    return {
      ok: false,
      code: "reversal_target_already_reversed",
      message: "This journal has already been reversed.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Orchestrator — runs all 11 in order, short-circuits on first failure.
// ---------------------------------------------------------------------------

export type PostValidationOpts = {
  actorId: string | null;
  organizationId: string;
  overridePassword?: string;
  overrideReason?: string;
};

export async function validateJournalForPost(
  tx: Tx,
  journalId: string,
  opts: PostValidationOpts
): Promise<ValidationResult & { needsOverride?: boolean }> {
  const r1 = await v1JournalIsDraft(tx, journalId);
  if (!r1.ok) return r1;
  const r2 = await v2AccountsActive(tx, journalId);
  if (!r2.ok) return r2;
  const r3 = await v3DirectPostingRule(tx, journalId);
  if (!r3.ok) return r3;
  const r4 = await v4DebitCreditEnforced(tx, journalId);
  if (!r4.ok) return r4;
  const r5 = await v5RequiredDimensions(tx, journalId);
  if (!r5.ok) return r5;
  const r6 = await v6DimensionCombinations(tx, journalId, opts.organizationId);
  if (!r6.ok) return r6;
  const r7 = await v7BalanceInJournalCurrency(tx, journalId);
  if (!r7.ok) return r7;
  const r8 = await v8BalanceInLocalCurrency(tx, journalId);
  if (!r8.ok) return r8;
  const r9 = await v9PeriodStatus(tx, journalId, opts);
  if (!r9.ok) return r9;
  const r10 = await v10UserPostingWindow(
    tx,
    journalId,
    opts.actorId,
    opts.organizationId
  );
  if (!r10.ok) return r10;
  const r11 = await v11ReversalIntegrity(tx, journalId);
  if (!r11.ok) return r11;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ancillary helpers — not part of the 11, used by createDraft.
// ---------------------------------------------------------------------------

/**
 * Resolve the fiscal_period_id for a journal_date. Throws if no period
 * covers the date (most likely cause: user hasn't generated a fiscal year yet).
 */
export async function resolvePeriodId(
  tx: Tx,
  organizationId: string,
  journalDate: string
): Promise<string> {
  const [row] = await tx
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.organizationId, organizationId),
        sql`${fiscalPeriods.startDate} <= ${journalDate}::date`,
        sql`${fiscalPeriods.endDate} >= ${journalDate}::date`
      )
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `No fiscal period covers ${journalDate}. Generate the fiscal year first.`
    );
  }
  return row.id;
}

/**
 * Compute local-currency amount from journal-currency amount + rate.
 * `rate` = units of local per 1 unit of journal currency.
 */
export function toLocal(amount: string | Decimal, rate: string | Decimal): string {
  const a = money(amount);
  const r = money(rate);
  return a.mul(r).toFixed(4);
}
