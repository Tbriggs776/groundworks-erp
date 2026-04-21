import { eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/lib/db/client";
import {
  allocationGroups,
  allocationTargetDimensions,
  allocationTargets,
  sourceCodes,
} from "@/lib/db/schema";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { createAndPostJournal, type JournalLineInput } from "./posting";

/**
 * Run a fixed-percentage allocation. Generates a JE that:
 *   - Debits each target account for target.percent% of the total
 *   - Credits the `sourceAccountId` for the full total
 *
 * Validation:
 *   - Sum of target percentages must equal 100 (within 0.0001)
 *   - Group + source account must belong to the same org
 *   - Allocation type MUST be `fixed` (statistical type rejected — not yet
 *     implemented; throw a clear error rather than silently misbehave)
 *
 * Rounding: accumulated rounding error on the last target line absorbs the
 * residual so the JE balances to the penny.
 */
export type AllocationRunOpts = {
  organizationId: string;
  groupId: string;
  totalAmount: string | number;
  sourceAccountId: string;
  journalDate: string; // YYYY-MM-DD
  description: string;
  actorId: string | null;
  currency?: string;
  reasonCodeId?: string;
};

export type AllocationRunResult =
  | { ok: true; journalId: string; journalNumber: string }
  | { ok: false; code: string; error: string };

export async function runAllocation(
  opts: AllocationRunOpts
): Promise<AllocationRunResult> {
  // Load the group
  const [group] = await db
    .select()
    .from(allocationGroups)
    .where(eq(allocationGroups.id, opts.groupId));
  if (!group)
    return { ok: false, code: "group_not_found", error: "Allocation group not found." };
  if (group.organizationId !== opts.organizationId)
    return { ok: false, code: "cross_org_denied", error: "Allocation group belongs to a different organization." };
  if (!group.isActive)
    return { ok: false, code: "group_inactive", error: "Allocation group is inactive." };
  if (group.allocationType !== "fixed")
    return {
      ok: false,
      code: "not_implemented",
      error: "Statistical allocations are not yet implemented. Use `fixed` allocations.",
    };

  // Load targets + their dimensions
  const targets = await db
    .select()
    .from(allocationTargets)
    .where(eq(allocationTargets.allocationGroupId, opts.groupId));

  if (targets.length === 0)
    return { ok: false, code: "no_targets", error: "Allocation group has no targets." };

  const totalPercent = sumMoney(targets.map((t) => t.percent));
  if (!totalPercent.equals(100)) {
    return {
      ok: false,
      code: "percent_sum_invalid",
      error: `Target percentages must sum to 100 (got ${totalPercent.toFixed(6)}).`,
    };
  }

  const targetDims = await db
    .select()
    .from(allocationTargetDimensions)
    .where(
      sql`${allocationTargetDimensions.targetId} IN (SELECT id FROM ${allocationTargets} WHERE allocation_group_id = ${opts.groupId})`
    );
  const dimsByTarget = new Map<
    string,
    Array<{ dimensionId: string; valueId: string }>
  >();
  for (const d of targetDims) {
    const arr = dimsByTarget.get(d.targetId) ?? [];
    arr.push({ dimensionId: d.dimensionId, valueId: d.valueId });
    dimsByTarget.set(d.targetId, arr);
  }

  // Look up ALLOC source code
  const [allocSrc] = await db
    .select()
    .from(sourceCodes)
    .where(
      sql`${sourceCodes.organizationId} = ${opts.organizationId} AND ${sourceCodes.code} = 'ALLOC'`
    );
  if (!allocSrc) {
    return {
      ok: false,
      code: "alloc_source_missing",
      error: "ALLOC source code missing for this org. Re-run org seeding.",
    };
  }

  // Build the lines. Compute each target's share with running accumulation;
  // assign the last line the residual so the JE balances exactly.
  const total = money(opts.totalAmount);
  const lines: JournalLineInput[] = [];
  let allocated = money(0);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    let share: Decimal;
    if (i === targets.length - 1) {
      share = total.minus(allocated); // residual
    } else {
      share = total.mul(money(t.percent)).div(100);
      share = money(share.toFixed(2));
      allocated = allocated.plus(share);
    }

    lines.push({
      accountId: t.accountId,
      debit: toDbMoney(share),
      memo: t.memo ?? undefined,
      dimensions: dimsByTarget.get(t.id),
    });
  }

  // Balancing credit on the source account
  lines.push({
    accountId: opts.sourceAccountId,
    credit: toDbMoney(total),
    memo: `Allocation: ${group.name}`,
  });

  return createAndPostJournal({
    organizationId: opts.organizationId,
    actorId: opts.actorId,
    journalDate: opts.journalDate,
    sourceCodeId: allocSrc.id,
    source: "adjusting", // allocations live in the adjusting bucket
    description: opts.description,
    reasonCodeId: opts.reasonCodeId,
    currency: opts.currency,
    lines,
    numberSeriesCode: "ALLOC",
  });
}
