import type { Ctx } from "@/lib/actor";
import { listBankingAccounts } from "@/lib/banking/transactions";
import { listAccounts } from "@/lib/gl/accounts";
import { listItems } from "@/lib/ar/items";
import { lotChoices } from "@/lib/ui/form-data";
import { listCustomers, listVendors } from "@/lib/parties/service";
import { toPurchaseItems } from "../_inventory/purchase-items";

/** Pick lists the banking forms share: bank side, categories, payees. */
export async function bankingChoices(ctx: Ctx) {
  const [bankAccounts, allAccounts, customers, vendors, items, lots] = await Promise.all([
    listBankingAccounts(ctx),
    listAccounts(ctx),
    listCustomers(ctx, { limit: 200 }),
    listVendors(ctx, { limit: 200 }),
    listItems(ctx, { limit: 200 }),
    lotChoices(ctx.actor.organizationId),
  ]);
  return {
    bankAccounts: bankAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name, isReconciliation: a.isReconciliation })),
    categories: allAccounts
      .filter((a) => a.accountType === "posting" && a.isActive && !a.isBlocked && a.directPosting)
      .map((a) => ({ id: a.id, code: a.code, name: a.name })),
    customers: customers.data.map((c) => ({ id: c.id, name: c.name })),
    vendors: vendors.data.map((v) => ({ id: v.id, name: v.name })),
    /** Products for expense and check lines. */
    items: toPurchaseItems(items.data),
    /** Specific identification: every lot, so a line can name one. */
    lots,
  };
}

export type BankingChoices = Awaited<ReturnType<typeof bankingChoices>>;
export type Choice = { id: string; code?: string; name: string };
