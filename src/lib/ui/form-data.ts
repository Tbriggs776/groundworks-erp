import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accounts, companyProfiles, customers, items, taxCodes, vendors } from "@/lib/db/schema";

/**
 * Reference data the sales forms need (customers, items, income accounts,
 * deposit and bank accounts, sales tax rates). Server-only; pages pass the
 * rows to client forms.
 */
export async function salesFormData(organizationId: string) {
  const [customerRows, itemRows, accountRows, rateRows] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, organizationId),
          eq(customers.isActive, true),
          isNull(customers.deletedAt)
        )
      )
      .orderBy(asc(customers.name)),
    db
      .select()
      .from(items)
      .where(
        and(
          eq(items.organizationId, organizationId),
          eq(items.isActive, true),
          isNull(items.deletedAt)
        )
      )
      .orderBy(asc(items.name)),
    db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          eq(accounts.accountType, "posting"),
          eq(accounts.isActive, true),
          eq(accounts.isBlocked, false)
        )
      )
      .orderBy(asc(accounts.code)),
    db
      .select({
        id: taxCodes.id,
        name: taxCodes.name,
        ratePercent: sql<string>`(SELECT COALESCE(SUM(r.rate_percent), 0) FROM tax_code_components c
          JOIN tax_rates r ON r.id = c.tax_rate_id WHERE c.tax_code_id = "tax_codes"."id")::text`,
      })
      .from(taxCodes)
      .where(and(eq(taxCodes.organizationId, organizationId), eq(taxCodes.isActive, true), isNull(taxCodes.deletedAt)))
      .orderBy(asc(taxCodes.name)),
  ]);
  // Inventory items carry what's on hand, so forms can warn before selling more.
  const stock = await db.execute<{ item_id: string; on_hand: string }>(sql`
    SELECT item_id, SUM(quantity)::text AS on_hand FROM inventory_movements
     WHERE organization_id = ${organizationId} AND voided_at IS NULL GROUP BY item_id
  `);
  const onHand = new Map(stock.map((r) => [r.item_id, r.on_hand]));
  return {
    customers: customerRows,
    items: itemRows.map((i) => ({ ...i, onHand: i.type === "inventory" ? (onHand.get(i.id) ?? "0") : null })),
    incomeAccounts: accountRows.filter(
      (a) => a.category === "income_statement" && a.directPosting && !a.isControl
    ),
    depositAccounts: accountRows.filter((a) => a.isCash),
    /** Where a refund can come from: bank, cash, or credit card. */
    bankAccounts: accountRows.filter((a) => a.isCash || a.isReconciliation),
    taxRates: rateRows,
  };
}

/** Reference data for purchase orders: vendors, items, line accounts, and the default ship-to. */
export async function purchaseFormData(organizationId: string) {
  const [vendorRows, itemRows, accountRows, [profile]] = await Promise.all([
    db
      .select()
      .from(vendors)
      .where(and(eq(vendors.organizationId, organizationId), eq(vendors.isActive, true), isNull(vendors.deletedAt)))
      .orderBy(asc(vendors.name)),
    db
      .select()
      .from(items)
      .where(and(eq(items.organizationId, organizationId), eq(items.isActive, true), isNull(items.deletedAt)))
      .orderBy(asc(items.name)),
    db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          eq(accounts.accountType, "posting"),
          eq(accounts.isActive, true),
          eq(accounts.isBlocked, false),
          eq(accounts.directPosting, true),
          eq(accounts.isControl, false)
        )
      )
      .orderBy(asc(accounts.code)),
    db.select({ address: companyProfiles.address }).from(companyProfiles).where(eq(companyProfiles.organizationId, organizationId)),
  ]);
  return { vendors: vendorRows, items: itemRows, accounts: accountRows, companyAddress: profile?.address ?? {} };
}
