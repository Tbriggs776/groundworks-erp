import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  taxAgencies,
  taxCodeComponents,
  taxCodes,
  taxRates,
  type TaxAgency,
} from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, notFound } from "@/lib/errors";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import { flag, id, optionalText } from "@/lib/schemas";

/**
 * SALES TAX AGENCIES AND RATES (manual, like QuickBooks).
 *
 * A "sales tax rate" a document picks is a tax code: one component (a
 * single rate) or several (a combined rate). Creating a single rate makes
 * both the component and its one-component code, under the same name.
 */

const percent = z
  .union([z.string().trim(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d{1,3}(\.\d{1,4})?$/.test(s) && money(s).lte(100), "Use a percentage from 0 to 100, e.g. \"8.25\".");

// ---------------------------------------------------------------------------
// Agencies
// ---------------------------------------------------------------------------

export const CreateTaxAgencySchema = z.object({
  name: z.string().trim().min(1).max(120).describe("Who the tax is paid to, e.g. \"Arizona Department of Revenue\"."),
  liabilityAccountId: id
    .optional()
    .describe("Liability account the tax accrues in. Defaults to 2200 Sales Tax Payable."),
  registrationNumber: optionalText(60),
  filingFrequency: z.enum(["monthly", "quarterly", "annually"]).optional(),
});
export const UpdateTaxAgencySchema = z.object({
  id,
  name: z.string().trim().min(1).max(120).optional(),
  liabilityAccountId: id.optional(),
  registrationNumber: optionalText(60),
  filingFrequency: z.enum(["monthly", "quarterly", "annually"]).optional(),
  isActive: z.boolean().optional(),
});
export const ListTaxAgenciesSchema = z.object({ includeInactive: flag.optional() });

async function requireLiabilityAccount(ctx: Ctx, accountId: string) {
  const [a] = await ctx.tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, ctx.actor.organizationId)));
  if (!a) throw notFound("Liability account");
  if (a.accountType !== "posting" || !a.isActive || a.isBlocked || a.isControl || a.normalBalance !== "credit" || a.category !== "balance_sheet") {
    throw new AppError("invalid_input", `${a.code} ${a.name} isn't an active liability posting account.`);
  }
  return a;
}

async function defaultLiabilityAccount(ctx: Ctx): Promise<string> {
  const [a] = await ctx.tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, ctx.actor.organizationId), eq(accounts.code, "2200")));
  if (!a) throw new AppError("invalid_input", "liabilityAccountId is required (this company has no 2200 Sales Tax Payable account).");
  return a.id;
}

export async function loadAgency(ctx: Ctx, agencyId: string): Promise<TaxAgency> {
  const [a] = await ctx.tx
    .select()
    .from(taxAgencies)
    .where(and(eq(taxAgencies.id, agencyId), eq(taxAgencies.organizationId, ctx.actor.organizationId)));
  if (!a) throw notFound("Tax agency");
  return a;
}

export async function listTaxAgencies(ctx: Ctx, input: z.input<typeof ListTaxAgenciesSchema> = {}) {
  requirePermission(ctx.actor, "read", "viewer", "list tax agencies");
  const f = ListTaxAgenciesSchema.parse(input);
  return ctx.tx
    .select({ agency: taxAgencies, liabilityAccountCode: accounts.code, liabilityAccountName: accounts.name })
    .from(taxAgencies)
    .innerJoin(accounts, eq(accounts.id, taxAgencies.liabilityAccountId))
    .where(and(eq(taxAgencies.organizationId, ctx.actor.organizationId), f.includeInactive ? undefined : eq(taxAgencies.isActive, true)))
    .orderBy(asc(taxAgencies.name))
    .then((rows) => rows.map((r) => ({ ...r.agency, liabilityAccountCode: r.liabilityAccountCode, liabilityAccountName: r.liabilityAccountName })));
}

export async function createTaxAgency(ctx: Ctx, input: z.input<typeof CreateTaxAgencySchema>): Promise<TaxAgency> {
  requirePermission(ctx.actor, "write", "accountant", "set up sales tax");
  const d = CreateTaxAgencySchema.parse(input);
  const liabilityAccountId = d.liabilityAccountId ?? (await defaultLiabilityAccount(ctx));
  await requireLiabilityAccount(ctx, liabilityAccountId);
  const [a] = await ctx.tx
    .insert(taxAgencies)
    .values({
      organizationId: ctx.actor.organizationId,
      name: d.name,
      liabilityAccountId,
      registrationNumber: d.registrationNumber,
      filingFrequency: d.filingFrequency,
    })
    .returning();
  await audit(ctx, "sales_tax.agency.created", "tax_agency", a.id, { name: a.name });
  return a;
}

export async function updateTaxAgency(ctx: Ctx, input: z.input<typeof UpdateTaxAgencySchema>): Promise<TaxAgency> {
  requirePermission(ctx.actor, "write", "accountant", "set up sales tax");
  const d = UpdateTaxAgencySchema.parse(input);
  const before = await loadAgency(ctx, d.id);
  if (d.liabilityAccountId) await requireLiabilityAccount(ctx, d.liabilityAccountId);
  const [a] = await ctx.tx
    .update(taxAgencies)
    .set({
      name: d.name ?? before.name,
      liabilityAccountId: d.liabilityAccountId ?? before.liabilityAccountId,
      registrationNumber: d.registrationNumber ?? before.registrationNumber,
      filingFrequency: d.filingFrequency ?? before.filingFrequency,
      isActive: d.isActive ?? before.isActive,
      updatedAt: sql`now()`,
    })
    .where(eq(taxAgencies.id, before.id))
    .returning();
  await audit(ctx, "sales_tax.agency.updated", "tax_agency", a.id, { before: pick(before), after: pick(a) });
  return a;
}

const pick = (a: TaxAgency) => ({ name: a.name, liabilityAccountId: a.liabilityAccountId, isActive: a.isActive });

// ---------------------------------------------------------------------------
// Rates (tax codes)
// ---------------------------------------------------------------------------

export const CreateTaxRateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).describe("What documents show, e.g. \"Phoenix 8.6%\"."),
    description: optionalText(300),
    agencyId: id.optional().describe("Single rate: the agency it's owed to."),
    ratePercent: percent.optional().describe("Single rate: the percentage, e.g. \"5.6\"."),
    componentIds: z
      .array(id)
      .min(2)
      .max(10)
      .optional()
      .describe("Combined rate: ids of existing single rates (from list_tax_rates) to add together."),
  })
  .refine((d) => (d.componentIds ? !d.agencyId && !d.ratePercent : Boolean(d.agencyId && d.ratePercent)), {
    message: "Give agencyId and ratePercent for a single rate, or componentIds for a combined rate.",
  });

export const UpdateTaxRateSchema = z.object({
  id,
  name: z.string().trim().min(1).max(120).optional(),
  description: optionalText(300),
  ratePercent: percent.optional().describe("Single rates only. Applies to documents saved from now on."),
  isActive: z.boolean().optional(),
});
export const ListTaxRatesSchema = z.object({ includeInactive: flag.optional() });

export type TaxRateComponent = {
  componentId: string;
  name: string;
  agencyId: string;
  agencyName: string;
  liabilityAccountId: string;
  ratePercent: string;
};
export type TaxRateRow = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  kind: "single" | "combined";
  ratePercent: string;
  components: TaxRateComponent[];
};

async function componentsFor(ctx: Ctx, codeIds: string[]): Promise<Map<string, TaxRateComponent[]>> {
  if (codeIds.length === 0) return new Map();
  const rows = await ctx.tx
    .select({
      codeId: taxCodeComponents.taxCodeId,
      componentId: taxRates.id,
      name: taxRates.name,
      agencyId: taxAgencies.id,
      agencyName: taxAgencies.name,
      liabilityAccountId: taxAgencies.liabilityAccountId,
      ratePercent: taxRates.ratePercent,
    })
    .from(taxCodeComponents)
    .innerJoin(taxRates, eq(taxRates.id, taxCodeComponents.taxRateId))
    .innerJoin(taxAgencies, eq(taxAgencies.id, taxRates.agencyId))
    .where(and(eq(taxCodeComponents.organizationId, ctx.actor.organizationId), inArray(taxCodeComponents.taxCodeId, codeIds)))
    .orderBy(asc(taxAgencies.name), asc(taxRates.name));
  const out = new Map<string, TaxRateComponent[]>();
  for (const { codeId, ...c } of rows) out.set(codeId, [...(out.get(codeId) ?? []), c]);
  return out;
}

function toRow(code: typeof taxCodes.$inferSelect, components: TaxRateComponent[]): TaxRateRow {
  return {
    id: code.id,
    name: code.name,
    description: code.description,
    isActive: code.isActive,
    kind: components.length > 1 ? "combined" : "single",
    ratePercent: toDbMoney(sumMoney(components.map((c) => c.ratePercent))),
    components,
  };
}

export async function listTaxRates(ctx: Ctx, input: z.input<typeof ListTaxRatesSchema> = {}): Promise<TaxRateRow[]> {
  requirePermission(ctx.actor, "read", "viewer", "list sales tax rates");
  const f = ListTaxRatesSchema.parse(input);
  const codes = await ctx.tx
    .select()
    .from(taxCodes)
    .where(
      and(
        eq(taxCodes.organizationId, ctx.actor.organizationId),
        isNull(taxCodes.deletedAt),
        f.includeInactive ? undefined : eq(taxCodes.isActive, true)
      )
    )
    .orderBy(asc(taxCodes.name));
  const comps = await componentsFor(ctx, codes.map((c) => c.id));
  return codes.map((c) => toRow(c, comps.get(c.id) ?? []));
}

export async function getTaxRate(ctx: Ctx, input: { id: string }): Promise<TaxRateRow> {
  requirePermission(ctx.actor, "read", "viewer", "view sales tax rates");
  const { id: codeId } = z.object({ id }).parse(input);
  const [code] = await ctx.tx
    .select()
    .from(taxCodes)
    .where(and(eq(taxCodes.id, codeId), eq(taxCodes.organizationId, ctx.actor.organizationId), isNull(taxCodes.deletedAt)));
  if (!code) throw notFound("Sales tax rate");
  return toRow(code, (await componentsFor(ctx, [code.id])).get(code.id) ?? []);
}

export async function createTaxRate(ctx: Ctx, input: z.input<typeof CreateTaxRateSchema>): Promise<TaxRateRow> {
  requirePermission(ctx.actor, "write", "accountant", "set up sales tax");
  const d = CreateTaxRateSchema.parse(input);
  const org = ctx.actor.organizationId;
  let componentIds: string[];
  if (d.componentIds) {
    if (new Set(d.componentIds).size !== d.componentIds.length) throw new AppError("invalid_input", "A component appears twice.");
    // Components are single rates: their codes have exactly one component.
    const singles = await listTaxRates(ctx, { includeInactive: true });
    const byCode = new Map(singles.filter((r) => r.kind === "single").map((r) => [r.id, r.components[0]]));
    componentIds = d.componentIds.map((cid) => {
      const c = byCode.get(cid);
      if (!c) throw new AppError("not_found", "A component isn't one of this company's single rates.");
      return c.componentId;
    });
  } else {
    const agency = await loadAgency(ctx, d.agencyId!);
    if (!agency.isActive) throw new AppError("invalid_input", `${agency.name} is inactive.`);
    const [rate] = await ctx.tx
      .insert(taxRates)
      .values({ organizationId: org, name: d.name, agencyId: agency.id, ratePercent: d.ratePercent! })
      .returning();
    componentIds = [rate.id];
  }
  const [code] = await ctx.tx
    .insert(taxCodes)
    .values({ organizationId: org, name: d.name, description: d.description })
    .returning();
  await ctx.tx
    .insert(taxCodeComponents)
    .values(componentIds.map((taxRateId) => ({ organizationId: org, taxCodeId: code.id, taxRateId })));
  const row = await getTaxRate(ctx, { id: code.id });
  await audit(ctx, "sales_tax.rate.created", "tax_code", code.id, { name: row.name, ratePercent: row.ratePercent, kind: row.kind });
  return row;
}

export async function updateTaxRate(ctx: Ctx, input: z.input<typeof UpdateTaxRateSchema>): Promise<TaxRateRow> {
  requirePermission(ctx.actor, "write", "accountant", "set up sales tax");
  const d = UpdateTaxRateSchema.parse(input);
  const before = await getTaxRate(ctx, { id: d.id });
  if (d.ratePercent !== undefined) {
    if (before.kind !== "single") throw new AppError("invalid_input", "A combined rate's percentage comes from its components; change those instead.");
    await ctx.tx
      .update(taxRates)
      .set({ ratePercent: d.ratePercent, updatedAt: sql`now()` })
      .where(eq(taxRates.id, before.components[0].componentId));
  }
  await ctx.tx
    .update(taxCodes)
    .set({
      name: d.name ?? before.name,
      description: d.description ?? before.description,
      isActive: d.isActive ?? before.isActive,
      updatedAt: sql`now()`,
    })
    .where(eq(taxCodes.id, before.id));
  if (before.kind === "single" && (d.name || d.isActive !== undefined)) {
    await ctx.tx
      .update(taxRates)
      .set({ name: d.name ?? before.name, isActive: d.isActive ?? before.isActive, updatedAt: sql`now()` })
      .where(eq(taxRates.id, before.components[0].componentId));
  }
  const after = await getTaxRate(ctx, { id: before.id });
  await audit(ctx, "sales_tax.rate.updated", "tax_code", before.id, {
    before: { name: before.name, ratePercent: before.ratePercent, isActive: before.isActive },
    after: { name: after.name, ratePercent: after.ratePercent, isActive: after.isActive },
  });
  return after;
}

// ---------------------------------------------------------------------------
// Computing tax on a document
// ---------------------------------------------------------------------------

export type ComputedTaxLine = {
  taxRateId: string;
  agencyId: string;
  liabilityAccountId: string;
  ratePercent: string;
  taxableAmount: string;
  taxAmount: string;
};
export type ComputedTax = {
  taxCodeId: string | null;
  taxExempt: boolean;
  taxableAmount: string;
  taxAmount: string;
  lines: ComputedTaxLine[];
};

const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Tax on the taxable total, rounded once (QuickBooks' way). A combined
 * rate's components are each rounded, then the last one absorbs the cent
 * so they add up to the rounded total. An exempt customer pays nothing,
 * but the components are still recorded (at zero) so the liability report
 * can show the exempt sales.
 */
export async function computeTax(
  ctx: Ctx,
  opts: { taxCodeId: string | null; exempt: boolean; taxable: Decimal }
): Promise<ComputedTax> {
  if (!opts.taxCodeId) return { taxCodeId: null, taxExempt: opts.exempt, taxableAmount: "0.0000", taxAmount: "0.0000", lines: [] };
  const rate = await getTaxRate(ctx, { id: opts.taxCodeId });
  if (!rate.isActive) throw new AppError("invalid_input", `Sales tax rate ${rate.name} is inactive.`);
  const taxable = opts.exempt || opts.taxable.lte(0) ? money(0) : cents(opts.taxable);
  const total = cents(taxable.times(money(rate.ratePercent)).div(100));
  const lines = rate.components.map((c) => ({
    taxRateId: c.componentId,
    agencyId: c.agencyId,
    liabilityAccountId: c.liabilityAccountId,
    ratePercent: c.ratePercent,
    taxableAmount: toDbMoney(taxable),
    amount: cents(taxable.times(money(c.ratePercent)).div(100)),
  }));
  const drift = total.minus(sumMoney(lines.map((l) => l.amount)));
  if (lines.length > 0 && !drift.isZero()) lines[lines.length - 1].amount = lines[lines.length - 1].amount.plus(drift);
  return {
    taxCodeId: rate.id,
    taxExempt: opts.exempt,
    taxableAmount: toDbMoney(taxable),
    taxAmount: toDbMoney(total),
    lines: lines.map(({ amount, ...l }) => ({ ...l, taxAmount: toDbMoney(amount) })),
  };
}

async function audit(ctx: Ctx, event: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  await writeAudit(
    { organizationId: ctx.actor.organizationId, ...auditFields(ctx.actor), event, entityType, entityId, metadata },
    ctx.tx
  );
}
