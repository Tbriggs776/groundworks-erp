import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accounts, customers, items } from "@/lib/db/schema";

/**
 * Reference data the sales forms need (customers, items, income accounts,
 * deposit accounts). Server-only; pages pass the rows to client forms.
 */
export async function salesFormData(organizationId: string) {
  const [customerRows, itemRows, accountRows] = await Promise.all([
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
  ]);
  return {
    customers: customerRows,
    items: itemRows,
    incomeAccounts: accountRows.filter(
      (a) => a.category === "income_statement" && a.directPosting && !a.isControl
    ),
    depositAccounts: accountRows.filter((a) => a.isCash),
  };
}
