import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bankRuleDirection,
  bankRules,
  type BankRule,
  type BankRuleCondition,
  type BankStatementLine,
  type DimensionTag,
} from "@/lib/db/schema";
import { auditFields, creatorFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, notFound } from "@/lib/errors";
import { requireDimensionTags, requireLineAccounts } from "@/lib/gl/lookups";
import { money } from "@/lib/money";
import { requireActiveCustomer, requireActiveVendor } from "@/lib/parties/service";
import { id, optionalText } from "@/lib/schemas";
import { DimensionTagSchema, requireBankingAccount } from "./common";

/**
 * BANK RULES — "when a statement line looks like this, categorize it like
 * that". Lowest priority number runs first; the first match wins. With
 * autoAdd, matching lines are recorded (posted) at import with no review.
 */

const ConditionSchema = z.object({
  field: z.enum(["description", "payee", "amount"]),
  op: z.enum(["contains", "not_contains", "equals", "starts_with", "greater_than", "less_than"]),
  value: z.string().trim().min(1).max(200),
});

const RuleFields = {
  name: z.string().trim().min(1).max(120),
  priority: z.number().int().min(0).max(10000).optional().describe("Lower runs first. Default 100."),
  isActive: z.boolean().optional(),
  accountId: id.nullable().optional().describe("Only lines from this bank / card account. Omit for every account."),
  direction: z.enum(bankRuleDirection.enumValues).optional().describe("money_in, money_out, or any (default)."),
  conditions: z
    .array(ConditionSchema)
    .min(1)
    .max(10)
    .describe(
      'Tests on the line. description/payee: contains, not_contains, equals, starts_with (case-insensitive). amount: equals, greater_than, less_than on the absolute amount, e.g. {"field":"amount","op":"less_than","value":"25"}.'
    ),
  matchAll: z.boolean().optional().describe("true (default): every condition must hold. false: any one."),
  categoryAccountId: id.nullable().optional().describe("Categorize to this account."),
  transferAccountId: id.nullable().optional().describe("Or record as a transfer with this bank / card account."),
  vendorId: id.nullable().optional(),
  customerId: id.nullable().optional(),
  payeeName: optionalText(200),
  memo: optionalText(500),
  dimensions: z.array(DimensionTagSchema).optional(),
  autoAdd: z.boolean().optional().describe("Record matching lines automatically at import (no review)."),
};

export const CreateBankRuleSchema = z.object(RuleFields);
export const UpdateBankRuleSchema = z.object({ id, ...RuleFields }).partial({ name: true, conditions: true });
export type CreateBankRuleInput = z.input<typeof CreateBankRuleSchema>;
export type UpdateBankRuleInput = z.input<typeof UpdateBankRuleSchema>;

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

function test(c: BankRuleCondition, line: Pick<BankStatementLine, "description" | "payee" | "amount">): boolean {
  if (c.field === "amount") {
    const amt = money(line.amount).abs();
    let v;
    try {
      v = money(c.value.replace(/[$,]/g, ""));
    } catch {
      return false;
    }
    if (c.op === "equals") return amt.eq(v);
    if (c.op === "greater_than") return amt.gt(v);
    if (c.op === "less_than") return amt.lt(v);
    return false;
  }
  const hay = (c.field === "payee" ? line.payee ?? "" : line.description).toLowerCase();
  const needle = c.value.toLowerCase();
  switch (c.op) {
    case "contains":
      return hay.includes(needle);
    case "not_contains":
      return !hay.includes(needle);
    case "equals":
      return hay.trim() === needle;
    case "starts_with":
      return hay.startsWith(needle);
    default:
      return false;
  }
}

export function ruleMatches(
  rule: BankRule,
  line: Pick<BankStatementLine, "accountId" | "description" | "payee" | "amount">
): boolean {
  if (!rule.isActive) return false;
  if (rule.accountId && rule.accountId !== line.accountId) return false;
  const amt = money(line.amount);
  if (rule.direction === "money_in" && amt.lte(0)) return false;
  if (rule.direction === "money_out" && amt.gte(0)) return false;
  if (rule.conditions.length === 0) return false;
  return rule.matchAll ? rule.conditions.every((c) => test(c, line)) : rule.conditions.some((c) => test(c, line));
}

/** Active rules in run order. */
export async function activeRules(ctx: Ctx, accountId?: string): Promise<BankRule[]> {
  return ctx.tx
    .select()
    .from(bankRules)
    .where(
      and(
        eq(bankRules.organizationId, ctx.actor.organizationId),
        eq(bankRules.isActive, true),
        isNull(bankRules.deletedAt),
        accountId ? or(isNull(bankRules.accountId), eq(bankRules.accountId, accountId)) : undefined
      )
    )
    .orderBy(asc(bankRules.priority), asc(bankRules.createdAt));
}

export function firstMatchingRule(rules: BankRule[], line: Pick<BankStatementLine, "accountId" | "description" | "payee" | "amount">) {
  return rules.find((r) => ruleMatches(r, line)) ?? null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function validateAction(
  ctx: Ctx,
  d: {
    accountId?: string | null;
    categoryAccountId?: string | null;
    transferAccountId?: string | null;
    vendorId?: string | null;
    customerId?: string | null;
    dimensions?: Array<{ dimensionId: string; valueId: string }>;
  }
) {
  const org = ctx.actor.organizationId;
  if (d.categoryAccountId && d.transferAccountId) {
    throw new AppError("invalid_input", "A rule categorizes to an account or records a transfer, not both.");
  }
  if (d.accountId) await requireBankingAccount(ctx.tx, org, d.accountId, { reconcilable: true });
  if (d.categoryAccountId) await requireLineAccounts(ctx.tx, org, [d.categoryAccountId]);
  if (d.transferAccountId) await requireBankingAccount(ctx.tx, org, d.transferAccountId, { label: "Transfer account" });
  if (d.vendorId && d.customerId) throw new AppError("invalid_input", "Pick a vendor or a customer, not both.");
  if (d.vendorId) await requireActiveVendor(ctx, d.vendorId);
  if (d.customerId) await requireActiveCustomer(ctx, d.customerId);
  await requireDimensionTags(ctx.tx, org, d.dimensions ?? []);
}

export async function listBankRules(ctx: Ctx): Promise<BankRule[]> {
  requirePermission(ctx.actor, "read", "viewer", "list bank rules");
  return ctx.tx
    .select()
    .from(bankRules)
    .where(and(eq(bankRules.organizationId, ctx.actor.organizationId), isNull(bankRules.deletedAt)))
    .orderBy(asc(bankRules.priority), asc(bankRules.createdAt));
}

async function loadRule(ctx: Ctx, ruleId: string): Promise<BankRule> {
  const [r] = await ctx.tx
    .select()
    .from(bankRules)
    .where(and(eq(bankRules.id, ruleId), eq(bankRules.organizationId, ctx.actor.organizationId), isNull(bankRules.deletedAt)));
  if (!r) throw notFound("Bank rule");
  return r;
}

export async function createBankRule(ctx: Ctx, input: CreateBankRuleInput): Promise<BankRule> {
  requirePermission(ctx.actor, "write", "accountant", "create bank rules");
  const d = CreateBankRuleSchema.parse(input);
  if (!d.categoryAccountId && !d.transferAccountId) {
    throw new AppError("invalid_input", "Say what to do: a categoryAccountId or a transferAccountId.");
  }
  await validateAction(ctx, d);
  const [rule] = await ctx.tx
    .insert(bankRules)
    .values({
      organizationId: ctx.actor.organizationId,
      name: d.name,
      priority: d.priority ?? 100,
      isActive: d.isActive ?? true,
      accountId: d.accountId ?? null,
      direction: d.direction ?? "any",
      conditions: d.conditions,
      matchAll: d.matchAll ?? true,
      categoryAccountId: d.categoryAccountId ?? null,
      transferAccountId: d.transferAccountId ?? null,
      vendorId: d.vendorId ?? null,
      customerId: d.customerId ?? null,
      payeeName: d.payeeName ?? null,
      memo: d.memo ?? null,
      dimensions: (d.dimensions ?? []) as DimensionTag[],
      autoAdd: d.autoAdd ?? false,
      ...creatorFields(ctx.actor),
    })
    .returning();
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "bank.rule.created",
      entityType: "bank_rule",
      entityId: rule.id,
      metadata: { name: rule.name, autoAdd: rule.autoAdd, conditions: rule.conditions },
    },
    ctx.tx
  );
  return rule;
}

export async function updateBankRule(ctx: Ctx, input: UpdateBankRuleInput): Promise<BankRule> {
  requirePermission(ctx.actor, "write", "accountant", "change bank rules");
  const d = UpdateBankRuleSchema.parse(input);
  const before = await loadRule(ctx, d.id);
  const next = {
    accountId: d.accountId === undefined ? before.accountId : d.accountId,
    categoryAccountId: d.categoryAccountId === undefined ? before.categoryAccountId : d.categoryAccountId,
    transferAccountId: d.transferAccountId === undefined ? before.transferAccountId : d.transferAccountId,
    vendorId: d.vendorId === undefined ? before.vendorId : d.vendorId,
    customerId: d.customerId === undefined ? before.customerId : d.customerId,
    dimensions: d.dimensions ?? before.dimensions,
  };
  if (!next.categoryAccountId && !next.transferAccountId) {
    throw new AppError("invalid_input", "A rule needs a categoryAccountId or a transferAccountId.");
  }
  await validateAction(ctx, next);
  const [rule] = await ctx.tx
    .update(bankRules)
    .set({
      ...next,
      dimensions: next.dimensions as DimensionTag[],
      name: d.name ?? before.name,
      priority: d.priority ?? before.priority,
      isActive: d.isActive ?? before.isActive,
      direction: d.direction ?? before.direction,
      conditions: d.conditions ?? before.conditions,
      matchAll: d.matchAll ?? before.matchAll,
      payeeName: d.payeeName === undefined ? before.payeeName : d.payeeName,
      memo: d.memo === undefined ? before.memo : d.memo,
      autoAdd: d.autoAdd ?? before.autoAdd,
      updatedAt: sql`now()`,
    })
    .where(eq(bankRules.id, d.id))
    .returning();
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "bank.rule.updated",
      entityType: "bank_rule",
      entityId: rule.id,
      metadata: { name: rule.name, autoAdd: rule.autoAdd, isActive: rule.isActive },
    },
    ctx.tx
  );
  return rule;
}

export async function deleteBankRule(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  requirePermission(ctx.actor, "write", "accountant", "delete bank rules");
  const { id: ruleId } = z.object({ id }).parse(input);
  const rule = await loadRule(ctx, ruleId);
  await ctx.tx.update(bankRules).set({ deletedAt: sql`now()`, isActive: false, updatedAt: sql`now()` }).where(eq(bankRules.id, ruleId));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "bank.rule.deleted",
      entityType: "bank_rule",
      entityId: ruleId,
      metadata: { name: rule.name },
    },
    ctx.tx
  );
  return { id: ruleId };
}
