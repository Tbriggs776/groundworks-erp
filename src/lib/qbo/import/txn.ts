import Decimal from "decimal.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { accounts, items, organizations, taxAgencies, taxRates, type DimensionTag } from "@/lib/db/schema";
import { auditFields } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { nextNumber } from "@/lib/gl/number-series";
import { money, sumMoney, toDbMoney } from "@/lib/money";
import type { ComputedTax, ComputedTaxLine } from "@/lib/sales-tax/rates";
import type { QboRecord } from "../client";
import { lineTags, setup } from "./journals";
import { attempt, type Kit, type Ref } from "./kit";

/**
 * What every QuickBooks transaction shares on its way in: its number, its
 * currency, whether QuickBooks voided it, how it was paid, and its lines
 * and sales tax with QuickBooks' own amounts (never recomputed here, so
 * the books tie to QuickBooks).
 */

export type PaymentMethod = "check" | "ach" | "wire" | "credit_card" | "cash" | "other";

export const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
export const amountOf = (v: unknown) => money(typeof v === "number" || typeof v === "string" ? String(v) : "0");
export const later = (a: string, b: string) => (a > b ? a : b);
export const dateOf = (r: QboRecord) => String(r.TxnDate);

/** QuickBooks zeroes a voided transaction and notes it "Voided". */
export function isVoided(r: QboRecord) {
  return amountOf(r.TotalAmt ?? r.Amount).isZero() && /\bvoided\b/i.test(String(r.PrivateNote ?? ""));
}

/** When QuickBooks voided it: its last change. */
export const voidedAt = (r: QboRecord) => {
  const t = (r.MetaData as { LastUpdatedTime?: string } | undefined)?.LastUpdatedTime;
  return t ? new Date(t) : new Date();
};

/** Import one transaction; a refused one is noted and remembered as skipped, so reruns don't retry it. */
export async function importTxn(kit: Kit, entity: string, r: QboRecord, label: string, fn: () => Promise<void>): Promise<"imported" | "skipped"> {
  const result = await attempt(kit, label, fn);
  if (result === "skipped") await kit.remember(entity, r.Id, null, "skipped");
  return result;
}

export async function currencyOf(kit: Kit, r: QboRecord) {
  const base = await kit.once("base-currency", async () => {
    const [o] = await kit.ctx.tx.select({ c: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, kit.org));
    return o.c;
  });
  return {
    currency: ((r.CurrencyRef as Ref)?.value ?? base).toUpperCase(),
    exchangeRate: typeof r.ExchangeRate === "number" && r.ExchangeRate > 0 ? String(r.ExchangeRate) : "1",
  };
}

/** QuickBooks' number when it has one that's free here, else the next in the series. */
export async function docNumber(kit: Kit, what: string, table: string, column: string, wanted: unknown, series: string): Promise<string> {
  const base = text(wanted, 50);
  if (!base) return nextNumber(kit.ctx.tx, kit.org, series);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const hit = await kit.ctx.tx.execute(
      sql`SELECT 1 FROM ${sql.identifier(table)} WHERE organization_id = ${kit.org} AND ${sql.identifier(column)} = ${candidate} LIMIT 1`
    );
    if (hit.length === 0) {
      if (n > 1) kit.note(`${what} ${base} is numbered ${candidate} here: QuickBooks has that number more than once.`);
      return candidate;
    }
  }
}

export function guessMethod(name?: string | null, creditCard?: boolean): PaymentMethod | null {
  if (creditCard) return "credit_card";
  if (!name) return null;
  if (/check|cheque|chq/i.test(name)) return "check";
  if (/cash/i.test(name)) return "cash";
  if (/wire/i.test(name)) return "wire";
  if (/ach|eft|direct|bank transfer|e-?check/i.test(name)) return "ach";
  if (/visa|master|amex|american express|discover|card|credit/i.test(name)) return "credit_card";
  return "other";
}

export async function methodOf(kit: Kit, ref: Ref, fallback: PaymentMethod): Promise<PaymentMethod> {
  const mapped = ref?.value ? (await kit.mapped("PaymentMethod", ref.value))?.value : null;
  return (mapped as PaymentMethod | null) ?? guessMethod(ref?.name) ?? fallback;
}

export async function auditVoided(kit: Kit, entityType: string, entityId: string, number: string) {
  await writeAudit(
    {
      organizationId: kit.org,
      ...auditFields(kit.ctx.actor),
      event: "qbo.import.voided",
      entityType,
      entityId,
      metadata: { number, note: "Voided in QuickBooks; imported voided, with zero amounts." },
    },
    kit.ctx.tx
  );
}

// ---------------------------------------------------------------------------
// Lookups, once per batch
// ---------------------------------------------------------------------------

type ItemInfo = { id: string; name: string; type: string; incomeAccountId: string; expenseAccountId: string | null; assetAccountId: string | null };

export function itemInfo(kit: Kit): Promise<Map<string, ItemInfo>> {
  return kit.once("items", async () => {
    const rows = await kit.ctx.tx
      .select({
        id: items.id,
        name: items.name,
        type: items.type,
        incomeAccountId: items.incomeAccountId,
        expenseAccountId: items.expenseAccountId,
        assetAccountId: items.assetAccountId,
      })
      .from(items)
      .where(eq(items.organizationId, kit.org));
    return new Map(rows.map((r) => [r.id, r]));
  });
}

export function accountByCode(kit: Kit, code: string): Promise<string | null> {
  return kit.once(`account:${code}`, async () => {
    const [a] = await kit.ctx.tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.organizationId, kit.org), eq(accounts.code, code)));
    return a?.id ?? null;
  });
}

/** The first active account of a kind, optionally named like `name`. */
function firstAccount(kit: Kit, subcategory: "operating_revenue" | "operating_expense", name?: RegExp): Promise<string | null> {
  return kit.once(`first:${subcategory}:${name?.source ?? ""}`, async () => {
    const rows = await kit.ctx.tx
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.organizationId, kit.org), eq(accounts.subcategory, subcategory), eq(accounts.isActive, true), eq(accounts.accountType, "posting")))
      .orderBy(asc(accounts.code));
    return (name ? rows.find((r) => name.test(r.name)) : rows[0])?.id ?? null;
  });
}

export const fallbackIncome = (kit: Kit) => firstAccount(kit, "operating_revenue");
export const fallbackExpense = async (kit: Kit) =>
  (await firstAccount(kit, "operating_expense", /uncategori[sz]ed/i)) ?? (await firstAccount(kit, "operating_expense"));
const shippingIncome = async (kit: Kit) => (await firstAccount(kit, "operating_revenue", /shipping/i)) ?? (await fallbackIncome(kit));

export async function tags(kit: Kit, classRef: Ref, deptRef: Ref): Promise<DimensionTag[]> {
  const s = await kit.once("journal-setup", () => setup(kit));
  return (await lineTags(kit, s, classRef, deptRef)) ?? [];
}

// ---------------------------------------------------------------------------
// Sales lines and tax
// ---------------------------------------------------------------------------

type QboSalesLine = {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  SalesItemLineDetail?: { ItemRef?: Ref; Qty?: number; UnitPrice?: number; TaxCodeRef?: Ref; ClassRef?: Ref; ItemAccountRef?: Ref };
  DiscountLineDetail?: { DiscountAccountRef?: Ref; PercentBased?: boolean; DiscountPercent?: number; ClassRef?: Ref };
  GroupLineDetail?: { Line?: QboSalesLine[] };
};

export type SalesLine = {
  itemId: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  accountId: string;
  taxable: boolean;
  dimensions: DimensionTag[];
  lotNumber: null;
};

const isTaxable = (ref: Ref) => Boolean(ref?.value) && ref!.value !== "NON";

function need(id: string | null | undefined, what: string): string {
  if (!id) throw new AppError("invalid_input", `${what} isn't in the chart of accounts.`);
  return id;
}

/** A sales document's lines, bundles expanded, with QuickBooks' amounts. */
export async function salesLines(kit: Kit, r: QboRecord, label: string): Promise<SalesLine[]> {
  const info = await itemInfo(kit);
  const dept = r.DepartmentRef as Ref;
  const out: SalesLine[] = [];
  const walk = async (lines: QboSalesLine[] | undefined) => {
    for (const l of lines ?? []) {
      if (l.DetailType === "GroupLineDetail") {
        await walk(l.GroupLineDetail?.Line);
      } else if (l.DetailType === "SalesItemLineDetail" && l.SalesItemLineDetail) {
        const d = l.SalesItemLineDetail;
        const amount = amountOf(l.Amount);
        const shipping = d.ItemRef?.value === "SHIPPING_ITEM_ID";
        const itemId = shipping ? null : await kit.local("Item", d.ItemRef);
        const item = itemId ? info.get(itemId) : undefined;
        if (!shipping && d.ItemRef?.value && !itemId) {
          kit.note(`${label}: ${d.ItemRef.name ?? `item ${d.ItemRef.value}`} isn't in Products and services, so its line came across without it.`);
        }
        const accountId =
          (await kit.local("Account", d.ItemAccountRef)) ?? (shipping ? await shippingIncome(kit) : (item?.incomeAccountId ?? (await fallbackIncome(kit))));
        const qty = d.Qty === undefined || amountOf(d.Qty).isZero() ? money(1) : amountOf(d.Qty);
        let unitPrice = d.UnitPrice === undefined ? amount.div(qty.abs()) : amountOf(d.UnitPrice).abs();
        if (amount.lt(0)) unitPrice = unitPrice.abs().neg();
        let lineItem = itemId;
        if (qty.lt(0) && item?.type === "inventory") {
          lineItem = null;
          kit.note(`${label}: a negative quantity of ${item.name} came across without moving stock.`);
        }
        out.push({
          itemId: lineItem,
          description: text(l.Description, 1000) ?? (shipping ? "Shipping" : (item?.name ?? null)),
          quantity: toDbMoney(qty.abs()),
          unitPrice: toDbMoney(unitPrice),
          amount: toDbMoney(amount),
          accountId: need(accountId, `${label}: the line's income account`),
          taxable: isTaxable(d.TaxCodeRef),
          dimensions: await tags(kit, d.ClassRef, dept),
          lotNumber: null,
        });
      } else if (l.DetailType === "DiscountLineDetail" && l.DiscountLineDetail) {
        const d = l.DiscountLineDetail;
        const amount = amountOf(l.Amount);
        if (amount.isZero()) continue;
        out.push({
          itemId: null,
          description: text(l.Description, 1000) ?? (d.PercentBased && d.DiscountPercent ? `Discount ${d.DiscountPercent}%` : "Discount"),
          quantity: "1.0000",
          unitPrice: toDbMoney(amount.neg()),
          amount: toDbMoney(amount.neg()),
          accountId: need((await kit.local("Account", d.DiscountAccountRef)) ?? (await accountByCode(kit, "4950")), `${label}: the discount account`),
          taxable: false,
          dimensions: await tags(kit, d.ClassRef, dept),
          lotNumber: null,
        });
      }
      // Subtotal and description-only lines carry no amount.
    }
  };
  await walk(r.Line as QboSalesLine[] | undefined);
  if (out.length === 0) throw new AppError("invalid_input", "it has no lines with an amount.");
  return out;
}

type RateInfo = { agencyId: string; liabilityAccountId: string; ratePercent: string };

function rateInfo(kit: Kit): Promise<Map<string, RateInfo>> {
  return kit.once("tax-rates", async () => {
    const rows = await kit.ctx.tx
      .select({ id: taxRates.id, agencyId: taxRates.agencyId, liabilityAccountId: taxAgencies.liabilityAccountId, ratePercent: taxRates.ratePercent })
      .from(taxRates)
      .innerJoin(taxAgencies, eq(taxAgencies.id, taxRates.agencyId))
      .where(eq(taxRates.organizationId, kit.org));
    return new Map(rows.map((r) => [r.id, r]));
  });
}

const FALLBACK_TAX = "QuickBooks sales tax";

/** Where tax that names no imported rate goes: its own agency and rate, on Sales Tax Payable. */
function fallbackRate(kit: Kit): Promise<RateInfo & { taxRateId: string }> {
  return kit.once("fallback-tax", async () => {
    const liability = need(await accountByCode(kit, "2200"), "Sales Tax Payable (2200)");
    let [agency] = await kit.ctx.tx
      .select()
      .from(taxAgencies)
      .where(and(eq(taxAgencies.organizationId, kit.org), eq(taxAgencies.name, FALLBACK_TAX)));
    agency ??= (await kit.ctx.tx.insert(taxAgencies).values({ organizationId: kit.org, name: FALLBACK_TAX, liabilityAccountId: liability }).returning())[0];
    let [rate] = await kit.ctx.tx.select().from(taxRates).where(and(eq(taxRates.organizationId, kit.org), eq(taxRates.name, FALLBACK_TAX)));
    rate ??= (await kit.ctx.tx.insert(taxRates).values({ organizationId: kit.org, name: FALLBACK_TAX, agencyId: agency.id, ratePercent: "0" }).returning())[0];
    return { taxRateId: rate.id, agencyId: agency.id, liabilityAccountId: agency.liabilityAccountId, ratePercent: "0.0000" };
  });
}

type TaxDetail = {
  TxnTaxCodeRef?: Ref;
  TotalTax?: number;
  TaxLine?: Array<{ Amount?: number; TaxLineDetail?: { TaxRateRef?: Ref; TaxPercent?: number; NetAmountTaxable?: number } }>;
};

/** The document's sales tax exactly as QuickBooks charged it, per rate. */
export async function salesTax(kit: Kit, r: QboRecord, lines: SalesLine[], label: string): Promise<ComputedTax> {
  const detail = r.TxnTaxDetail as TaxDetail | undefined;
  const total = amountOf(detail?.TotalTax);
  const taxable = sumMoney(lines.filter((l) => l.taxable).map((l) => l.amount));
  const rates = await rateInfo(kit);
  const out: ComputedTaxLine[] = [];
  for (const t of detail?.TaxLine ?? []) {
    const d = t.TaxLineDetail;
    const rateId = await kit.local("TaxRate", d?.TaxRateRef);
    const rate = rateId ? rates.get(rateId) : undefined;
    if (!d || !rateId || !rate) continue;
    out.push({
      taxRateId: rateId,
      agencyId: rate.agencyId,
      liabilityAccountId: rate.liabilityAccountId,
      ratePercent: d.TaxPercent === undefined ? rate.ratePercent : toDbMoney(amountOf(d.TaxPercent)),
      taxableAmount: toDbMoney(d.NetAmountTaxable === undefined ? taxable : amountOf(d.NetAmountTaxable)),
      taxAmount: toDbMoney(amountOf(t.Amount)),
    });
  }
  const rest = total.minus(sumMoney(out.map((l) => l.taxAmount)));
  if (!rest.isZero()) {
    const f = await fallbackRate(kit);
    out.push({ ...f, taxableAmount: toDbMoney(taxable), taxAmount: toDbMoney(rest) });
    kit.note(`${label}: ${rest.toFixed(2)} of its sales tax names no QuickBooks tax rate here, so it's under "${FALLBACK_TAX}".`);
  }
  return {
    taxCodeId: await kit.local("TaxCode", detail?.TxnTaxCodeRef),
    taxExempt: false,
    taxableAmount: toDbMoney(taxable),
    taxAmount: toDbMoney(total),
    lines: out,
  };
}

/** Header totals; notes when they don't match QuickBooks' (they still post as the lines say). */
export function salesTotals(kit: Kit, label: string, r: QboRecord, lines: SalesLine[], tax: ComputedTax) {
  const subtotal = sumMoney(lines.map((l) => l.amount));
  const total = subtotal.plus(money(tax.taxAmount));
  checkTotal(kit, label, total, r.TotalAmt);
  return {
    subtotalAmount: toDbMoney(subtotal),
    taxCodeId: tax.taxCodeId,
    taxExempt: false,
    taxableAmount: tax.taxableAmount,
    taxAmount: tax.taxAmount,
    totalAmount: toDbMoney(total),
    total,
  };
}

export function checkTotal(kit: Kit, label: string, total: Decimal, qbo: unknown) {
  if (qbo !== undefined && !total.eq(amountOf(qbo))) {
    kit.note(`${label} totals ${total.toFixed(2)} here but ${amountOf(qbo).toFixed(2)} in QuickBooks. Check it against QuickBooks.`);
  }
}

// ---------------------------------------------------------------------------
// Purchase lines
// ---------------------------------------------------------------------------

type QboPurchaseLine = {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string; TxnLineId?: string }>;
  AccountBasedExpenseLineDetail?: { AccountRef?: Ref; ClassRef?: Ref; CustomerRef?: Ref };
  ItemBasedExpenseLineDetail?: { ItemRef?: Ref; Qty?: number; UnitPrice?: number; ClassRef?: Ref; CustomerRef?: Ref };
};

export type PurchaseLine = {
  accountId: string;
  amount: string;
  description: string | null;
  itemId: string | null;
  quantity: string | null;
  unitCost: string | null;
  dimensions: DimensionTag[];
  customerId: string | null;
  /** QuickBooks' line id, and the purchase order line it bills ("<po id>:<line id>"). */
  qboLineId: string | null;
  poLine: string | null;
};

const poLineOf = (l: QboPurchaseLine) => {
  const t = l.LinkedTxn?.find((x) => x.TxnType === "PurchaseOrder" && x.TxnId && x.TxnLineId);
  return t ? `${t.TxnId}:${t.TxnLineId}` : null;
};

/**
 * Lines of a bill, vendor credit, expense, or check. An inventory item's
 * line hits its asset account when buying (`stock: "in"`) and its cost of
 * goods sold account when sending it back (`"out"`), as the app does.
 */
export async function purchaseLines(kit: Kit, r: QboRecord, label: string, stock: "in" | "out"): Promise<PurchaseLine[]> {
  const info = await itemInfo(kit);
  const dept = r.DepartmentRef as Ref;
  const out: PurchaseLine[] = [];
  for (const l of (r.Line as QboPurchaseLine[] | undefined) ?? []) {
    const amount = amountOf(l.Amount);
    // A zero line moves nothing in the ledger (and the ledger takes no zero lines).
    if (amount.isZero()) continue;
    if (l.DetailType === "AccountBasedExpenseLineDetail" && l.AccountBasedExpenseLineDetail) {
      const d = l.AccountBasedExpenseLineDetail;
      out.push({
        accountId: need(await kit.local("Account", d.AccountRef), `${label}: account ${d.AccountRef?.name ?? d.AccountRef?.value ?? "(none)"}`),
        amount: toDbMoney(amount),
        description: text(l.Description, 1000),
        itemId: null,
        quantity: null,
        unitCost: null,
        dimensions: await tags(kit, d.ClassRef, dept),
        customerId: await kit.local("Customer", d.CustomerRef),
        qboLineId: l.Id ?? null,
        poLine: poLineOf(l),
      });
    } else if (l.DetailType === "ItemBasedExpenseLineDetail" && l.ItemBasedExpenseLineDetail) {
      const d = l.ItemBasedExpenseLineDetail;
      const itemId = await kit.local("Item", d.ItemRef);
      const item = itemId ? info.get(itemId) : undefined;
      if (!item) throw new AppError("invalid_input", `${d.ItemRef?.name ?? "an item"} isn't in Products and services.`);
      const inventory = item.type === "inventory";
      const qty = d.Qty === undefined ? null : amountOf(d.Qty);
      let keepItem = true;
      if (inventory && (!qty || qty.lte(0))) {
        keepItem = false;
        kit.note(`${label}: ${item.name} came across without moving stock (no positive quantity).`);
      }
      const accountId = inventory && keepItem ? (stock === "in" ? item.assetAccountId : item.expenseAccountId) : (item.expenseAccountId ?? (await fallbackExpense(kit)));
      out.push({
        accountId: need(accountId, `${label}: ${item.name}'s account`),
        amount: toDbMoney(amount),
        description: text(l.Description, 1000) ?? item.name,
        itemId: keepItem ? item.id : null,
        quantity: keepItem && qty ? toDbMoney(qty) : null,
        unitCost: d.UnitPrice === undefined ? null : toDbMoney(amountOf(d.UnitPrice)),
        dimensions: await tags(kit, d.ClassRef, dept),
        customerId: await kit.local("Customer", d.CustomerRef),
        qboLineId: l.Id ?? null,
        poLine: poLineOf(l),
      });
    }
  }
  if (out.length === 0) throw new AppError("invalid_input", "it has no lines with an amount.");
  return out;
}
