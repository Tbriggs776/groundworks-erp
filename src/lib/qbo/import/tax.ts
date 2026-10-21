import { and, eq } from "drizzle-orm";
import { accounts, taxAgencies, taxCodeComponents, taxCodes, taxRates } from "@/lib/db/schema";
import { auditFields } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { toDbMoney } from "@/lib/money";
import { pagedStep, type Kit, type Ref } from "./kit";
import { accountByCode, amountOf, guessMethod, text } from "./txn";

/**
 * Sales tax set up the way QuickBooks had it: agencies, each rate (a
 * component owed to one agency, with its own single "sales tax rate" like
 * the app makes), and combined codes that add rates together. Documents
 * then carry QuickBooks' tax amounts per rate.
 */

const ACTIVE_OR_NOT = "Active in (true, false)";

/** A name that's free in `table` (names are unique per company). */
async function freeName(kit: Kit, table: typeof taxAgencies | typeof taxRates | typeof taxCodes, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} (${n})`;
    const [hit] = await kit.ctx.tx.select({ id: table.id }).from(table).where(and(eq(table.organizationId, kit.org), eq(table.name, candidate)));
    if (!hit) return candidate;
  }
}

const audit = (kit: Kit, event: string, entityType: string, entityId: string, metadata: Record<string, unknown>) =>
  writeAudit({ organizationId: kit.org, ...auditFields(kit.ctx.actor), event, entityType, entityId, metadata }, kit.ctx.tx);

export const taxAgenciesStep = pagedStep({
  key: "tax_agencies",
  label: "Sales tax agencies",
  entity: "TaxAgency",
  async importOne(kit, r) {
    const name = await freeName(kit, taxAgencies, text(r.DisplayName ?? r.Name, 120) ?? `Agency ${r.Id}`);
    // QuickBooks keeps each agency's tax in "<agency> Payable"; otherwise 2200.
    const [own] = await kit.ctx.tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, kit.org), eq(accounts.name, `${String(r.DisplayName)} Payable`), eq(accounts.normalBalance, "credit")));
    const liabilityAccountId = own?.id ?? (await accountByCode(kit, "2200"));
    if (!liabilityAccountId) throw new AppError("invalid_state", "There's no 2200 Sales Tax Payable account.");
    const [a] = await kit.ctx.tx.insert(taxAgencies).values({ organizationId: kit.org, name, liabilityAccountId }).returning();
    await audit(kit, "sales_tax.agency.created", "tax_agency", a.id, { name, importedFrom: "quickbooks" });
    await kit.remember("TaxAgency", r.Id, a.id);
    return "imported";
  },
});

export const taxRatesStep = pagedStep({
  key: "tax_rates",
  label: "Sales tax rates",
  entity: "TaxRate",
  where: ACTIVE_OR_NOT,
  preload: ["TaxAgency"],
  async importOne(kit, r) {
    const agencyId = await kit.local("TaxAgency", r.AgencyRef as Ref);
    if (!agencyId) {
      kit.note(`Tax rate ${String(r.Name)} didn't come across: its agency isn't here.`);
      await kit.remember("TaxRate", r.Id, null, "skipped");
      return "skipped";
    }
    const name = await freeName(kit, taxRates, text(r.Name, 120) ?? `Rate ${r.Id}`);
    const active = r.Active !== false;
    const [rate] = await kit.ctx.tx
      .insert(taxRates)
      .values({ organizationId: kit.org, name, agencyId, ratePercent: toDbMoney(amountOf(r.RateValue)), isActive: active })
      .returning();
    // Like the app: every rate is also a single "sales tax rate" documents can pick.
    const [code] = await kit.ctx.tx
      .insert(taxCodes)
      .values({ organizationId: kit.org, name: await freeName(kit, taxCodes, name), description: text(r.Description, 300), isActive: active })
      .returning();
    await kit.ctx.tx.insert(taxCodeComponents).values({ organizationId: kit.org, taxCodeId: code.id, taxRateId: rate.id });
    await audit(kit, "sales_tax.rate.created", "tax_code", code.id, { name, ratePercent: rate.ratePercent, kind: "single", importedFrom: "quickbooks" });
    await kit.remember("TaxRate", r.Id, rate.id, code.id);
    return "imported";
  },
});

type RateList = { TaxRateDetail?: Array<{ TaxRateRef?: Ref }> };

export const taxCodesStep = pagedStep({
  key: "tax_codes",
  label: "Combined sales tax rates",
  entity: "TaxCode",
  where: ACTIVE_OR_NOT,
  preload: ["TaxRate"],
  async importOne(kit, r) {
    const rates: Array<{ rateId: string; codeId: string | null }> = [];
    for (const d of (r.SalesTaxRateList as RateList | undefined)?.TaxRateDetail ?? []) {
      const m = d.TaxRateRef?.value ? await kit.mapped("TaxRate", d.TaxRateRef.value) : null;
      if (m?.localId) rates.push({ rateId: m.localId, codeId: m.value });
    }
    // "TAX" / "NON" (and purchase-only codes) carry no sales rate: they come
    // across as each line's taxable flag.
    if (rates.length === 0) {
      await kit.remember("TaxCode", r.Id, null, "no sales rates");
      return "imported";
    }
    if (rates.length === 1) {
      await kit.remember("TaxCode", r.Id, rates[0].codeId);
      return "imported";
    }
    const name = await freeName(kit, taxCodes, text(r.Name, 120) ?? `Tax code ${r.Id}`);
    const [code] = await kit.ctx.tx
      .insert(taxCodes)
      .values({ organizationId: kit.org, name, description: text(r.Description, 300), isActive: r.Active !== false })
      .returning();
    await kit.ctx.tx
      .insert(taxCodeComponents)
      .values([...new Set(rates.map((x) => x.rateId))].map((taxRateId) => ({ organizationId: kit.org, taxCodeId: code.id, taxRateId })));
    await audit(kit, "sales_tax.rate.created", "tax_code", code.id, { name, kind: "combined", components: rates.length, importedFrom: "quickbooks" });
    await kit.remember("TaxCode", r.Id, code.id);
    return "imported";
  },
});

/** QuickBooks' payment methods, as the app's (check, cash, card, ACH, wire, other). */
export const paymentMethodsStep = pagedStep({
  key: "payment_methods",
  label: "Payment methods",
  entity: "PaymentMethod",
  where: ACTIVE_OR_NOT,
  async importOne(kit, r) {
    await kit.remember("PaymentMethod", r.Id, null, guessMethod(String(r.Name ?? ""), r.Type === "CREDIT_CARD"));
    return "imported";
  },
});
