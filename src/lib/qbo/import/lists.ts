import { and, eq, sql } from "drizzle-orm";
import { accounts, dimensions, dimensionValues, organizations } from "@/lib/db/schema";
import { auditFields } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { createItem } from "@/lib/ar/items";
import { updateCompanyProfile } from "@/lib/company/profile";
import { createCustomer, createVendor } from "@/lib/parties/service";
import type { QboRecord } from "../client";
import { attempt, pagedStep, type Kit, type Ref, type Step } from "./kit";

/**
 * The company and its lists: company info and preferences, terms, classes
 * and departments (as Class and Location values), customers, vendors, and
 * products and services. Customers, vendors, and items go through the same
 * services the app uses, so they're validated and audited the same way.
 */

const ACTIVE_OR_NOT = "Active in (true, false)";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type QboAddress = { Line1?: string; Line2?: string; City?: string; CountrySubDivisionCode?: string; PostalCode?: string; Country?: string } | undefined;

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function address(a: QboAddress) {
  if (!a || !(a.Line1 || a.City || a.PostalCode)) return undefined;
  return {
    street1: text(a.Line1, 200) ?? "",
    street2: text(a.Line2, 200),
    city: text(a.City, 100),
    state: text(a.CountrySubDivisionCode, 100),
    zip: text(a.PostalCode, 20),
    country: text(a.Country, 100),
  };
}

/** QuickBooks allows a list of addresses in one field; keep the first that looks like an email. */
function email(v: unknown): string | undefined {
  const first = typeof v === "string" ? v.split(/[,;\s]+/).find((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)) : undefined;
  return first?.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

export const companyStep: Step = {
  key: "company",
  label: "Company and preferences",
  async run(kit) {
    const info = (await kit.client.get<{ CompanyInfo: QboRecord }>(`companyinfo/${kit.client.realmId}`)).CompanyInfo;
    const prefs = (await kit.client.get<{ Preferences: Record<string, Record<string, unknown>> }>("preferences")).Preferences;
    const firstMonth = String(prefs.AccountingInfoPrefs?.FirstMonthOfFiscalYear ?? info.FiscalYearStartMonth ?? "January");
    const startMonth = Math.max(1, MONTHS.indexOf(firstMonth) + 1);
    const home = ((prefs.CurrencyPrefs?.HomeCurrency as Ref)?.value ?? "USD").toUpperCase();
    await kit.ctx.tx
      .update(organizations)
      .set({ fiscalYearStartMonth: startMonth, baseCurrency: home, updatedAt: sql`now()` })
      .where(eq(organizations.id, kit.org));
    await updateCompanyProfile(kit.ctx, {
      legalName: text(info.LegalName, 200) ?? text(info.CompanyName, 200),
      address: address(info.CompanyAddr as QboAddress),
      phone: text((info.PrimaryPhone as { FreeFormNumber?: string })?.FreeFormNumber, 50),
      email: email((info.Email as { Address?: string })?.Address) ?? null,
      website: text((info.WebAddr as { URI?: string })?.URI, 200),
    });
    if (prefs.CurrencyPrefs?.MultiCurrencyEnabled) {
      kit.note("QuickBooks has multicurrency on. Foreign-currency customers, vendors, and accounts come across in their currency; check exchange rates after the import.");
    }
    kit.count("company", "imported");
    return { done: true, position: 1 };
  },
};

// ---------------------------------------------------------------------------
// Terms, classes, departments
// ---------------------------------------------------------------------------

/** Terms aren't rows here: customers and vendors carry net days. */
export const termsStep = pagedStep({
  key: "terms",
  label: "Terms",
  entity: "Term",
  where: ACTIVE_OR_NOT,
  async importOne(kit, r) {
    const days = typeof r.DueDays === "number" ? r.DueDays : 30;
    if (typeof r.DueDays !== "number") kit.note(`Term "${String(r.Name)}" is date-driven in QuickBooks; customers and vendors on it get Net 30.`);
    await kit.remember("Term", r.Id, null, String(days));
    return "imported";
  },
});

async function dimensionId(kit: Kit, code: string): Promise<string> {
  const [d] = await kit.ctx.tx
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(and(eq(dimensions.organizationId, kit.org), eq(dimensions.code, code)));
  return d.id;
}

function dimensionStep(key: string, label: string, entity: "Class" | "Department", dimensionCode: string): Step {
  return pagedStep({
    key,
    label,
    entity,
    where: ACTIVE_OR_NOT,
    async importOne(kit, r) {
      const dimId = await dimensionId(kit, dimensionCode);
      const name = String(r.FullyQualifiedName ?? r.Name).slice(0, 200);
      const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "VALUE";
      let code = base;
      for (let n = 2; ; n++) {
        const [hit] = await kit.ctx.tx
          .select({ id: dimensionValues.id })
          .from(dimensionValues)
          .where(and(eq(dimensionValues.organizationId, kit.org), eq(dimensionValues.dimensionId, dimId), eq(dimensionValues.code, code)));
        if (!hit) break;
        code = `${base}-${n}`;
      }
      const parent = await kit.local(entity, r.ParentRef as Ref);
      const [row] = await kit.ctx.tx
        .insert(dimensionValues)
        .values({ organizationId: kit.org, dimensionId: dimId, code, name, parentValueId: parent, isBlocked: r.Active === false })
        .returning({ id: dimensionValues.id });
      await kit.remember(entity, r.Id, row.id);
      return "imported";
    },
  });
}

export const classesStep = dimensionStep("classes", "Classes", "Class", "CLASS");
export const departmentsStep = dimensionStep("departments", "Departments (locations)", "Department", "LOCATION");

// ---------------------------------------------------------------------------
// Customers, vendors
// ---------------------------------------------------------------------------

async function termDays(kit: Kit, ref: Ref): Promise<number | undefined> {
  if (!ref?.value) return undefined;
  const v = (await kit.mapped("Term", ref.value))?.value;
  return v ? Math.min(365, Number(v)) : undefined;
}

function addresses(r: QboRecord, kinds: Array<["BillAddr" | "ShipAddr", "billing" | "shipping"]>) {
  return kinds.flatMap(([field, type]) => {
    const a = address(r[field] as QboAddress);
    return a && a.street1 ? [{ type, ...a }] : [];
  });
}

export const customersStep = pagedStep({
  key: "customers",
  label: "Customers",
  entity: "Customer",
  where: ACTIVE_OR_NOT,
  preload: ["Term"],
  async importOne(kit, r) {
    const name = String(r.DisplayName ?? r.FullyQualifiedName ?? r.CompanyName ?? `Customer ${r.Id}`).slice(0, 200);
    return attempt(kit, `Customer ${name}`, async () => {
      const c = await createCustomer(kit.ctx, {
        name,
        email: email((r.PrimaryEmailAddr as { Address?: string })?.Address) ?? null,
        phone: text((r.PrimaryPhone as { FreeFormNumber?: string })?.FreeFormNumber, 50),
        defaultPaymentTermsDays: await termDays(kit, r.SalesTermRef as Ref),
        currency: (r.CurrencyRef as Ref)?.value,
        notes: text(r.Notes, 4000),
        isActive: r.Active !== false,
        taxExempt: r.Taxable === false ? true : undefined,
        addresses: addresses(r, [
          ["BillAddr", "billing"],
          ["ShipAddr", "shipping"],
        ]),
      });
      await kit.remember("Customer", r.Id, c.id);
    });
  },
});

export const vendorsStep = pagedStep({
  key: "vendors",
  label: "Vendors",
  entity: "Vendor",
  where: ACTIVE_OR_NOT,
  preload: ["Term"],
  async importOne(kit, r) {
    const name = String(r.DisplayName ?? r.CompanyName ?? `Vendor ${r.Id}`).slice(0, 200);
    if (r.Vendor1099) kit.note(`${name} is a 1099 vendor. QuickBooks doesn't share full tax IDs: add it on the vendor before filing.`);
    return attempt(kit, `Vendor ${name}`, async () => {
      const v = await createVendor(kit.ctx, {
        name,
        email: email((r.PrimaryEmailAddr as { Address?: string })?.Address) ?? null,
        phone: text((r.PrimaryPhone as { FreeFormNumber?: string })?.FreeFormNumber, 50),
        defaultPaymentTermsDays: await termDays(kit, r.TermRef as Ref),
        currency: (r.CurrencyRef as Ref)?.value,
        notes: text(r.Notes, 4000),
        isActive: r.Active !== false,
        is1099Vendor: r.Vendor1099 === true,
        addresses: addresses(r, [["BillAddr", "billing"]]),
      });
      await kit.remember("Vendor", r.Id, v.id);
    });
  },
});

// ---------------------------------------------------------------------------
// Products and services
// ---------------------------------------------------------------------------

const ITEM_TYPE: Record<string, "service" | "non_inventory" | "inventory"> = {
  Service: "service",
  NonInventory: "non_inventory",
  Inventory: "inventory",
};

async function fallbackIncome(kit: Kit): Promise<string | null> {
  const [a] = await kit.ctx.tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, kit.org), eq(accounts.subcategory, "operating_revenue"), eq(accounts.isActive, true), eq(accounts.normalBalance, "credit")))
    .orderBy(accounts.code)
    .limit(1);
  return a?.id ?? null;
}

export const itemsStep = pagedStep({
  key: "items",
  label: "Products and services",
  entity: "Item",
  where: ACTIVE_OR_NOT,
  preload: ["Account"],
  async importOne(kit, r) {
    const type = ITEM_TYPE[String(r.Type)];
    const name = String(r.SubItem ? (r.FullyQualifiedName ?? r.Name) : r.Name).slice(0, 200);
    if (!type) {
      // Categories group items in QuickBooks' lists; bundles have no equivalent yet.
      if (r.Type === "Group") kit.note(`Bundle "${name}" didn't come across: bundles aren't supported yet. Its items did.`);
      await kit.remember("Item", r.Id, null, String(r.Type));
      return "skipped";
    }
    const incomeAccountId = (await kit.local("Account", r.IncomeAccountRef as Ref)) ?? (await fallbackIncome(kit));
    return attempt(kit, `Item ${name}`, async () => {
      const item = await createItem(kit.ctx, {
        name,
        sku: text(r.Sku, 64),
        type,
        description: text(r.Description, 1000),
        salesPrice: typeof r.UnitPrice === "number" ? String(r.UnitPrice) : null,
        purchaseCost: typeof r.PurchaseCost === "number" ? String(r.PurchaseCost) : null,
        incomeAccountId: incomeAccountId!,
        expenseAccountId: await kit.local("Account", r.ExpenseAccountRef as Ref),
        assetAccountId: type === "inventory" ? await kit.local("Account", r.AssetAccountRef as Ref) : null,
        taxable: r.Taxable === true,
        isActive: r.Active !== false,
      });
      await kit.remember("Item", r.Id, item.id);
    });
  },
});

export async function auditStep(kit: Kit, step: string) {
  await writeAudit(
    {
      organizationId: kit.org,
      ...auditFields(kit.ctx.actor),
      event: "qbo.import.step",
      entityType: "organization",
      entityId: kit.org,
      metadata: { step, counts: kit.counts[step] ?? null },
    },
    kit.ctx.tx
  );
}
