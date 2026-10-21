import { and, eq, sql } from "drizzle-orm";
import { accounts, type Account } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { auditFields } from "@/lib/actor";
import { PAGE_SIZE, type QboRecord } from "../client";
import type { Kit, Ref, Step } from "./kit";

/**
 * The chart of accounts comes across as QuickBooks has it. The accounts the
 * books run on (Accounts Receivable, Accounts Payable, Undeposited Funds,
 * Sales Tax Payable, Inventory Asset, Opening Balance Equity, Retained
 * Earnings, Discounts Given) take over Groundworks' own, keeping its number
 * (subledgers find them by it) and taking QuickBooks' name. Every other
 * account is added with its QuickBooks number when it has one that's free,
 * or the next free number in its type's range. Groundworks' default
 * accounts nothing maps to are made inactive.
 */

type Shape = {
  subcategory: Account["subcategory"];
  range: [number, number];
  isCash?: boolean;
  isReconciliation?: boolean;
};

const BY_TYPE: Record<string, Shape> = {
  Bank: { subcategory: "cash", range: [1000, 1100], isCash: true, isReconciliation: true },
  "Accounts Receivable": { subcategory: "receivables", range: [1100, 1300] },
  "Other Current Asset": { subcategory: "other_current_asset", range: [1300, 1500] },
  "Fixed Asset": { subcategory: "fixed_assets", range: [1500, 1900] },
  "Other Asset": { subcategory: "other_asset", range: [1900, 2000] },
  "Accounts Payable": { subcategory: "payables", range: [2000, 2100] },
  "Credit Card": { subcategory: "other_current_liability", range: [2100, 2200], isReconciliation: true },
  "Other Current Liability": { subcategory: "other_current_liability", range: [2200, 2500] },
  "Long Term Liability": { subcategory: "lt_debt", range: [2500, 3000] },
  Equity: { subcategory: "equity", range: [3000, 4000] },
  Income: { subcategory: "operating_revenue", range: [4000, 4900] },
  "Other Income": { subcategory: "other_revenue", range: [4900, 5000] },
  "Cost of Goods Sold": { subcategory: "cogs_materials", range: [5000, 6000] },
  Expense: { subcategory: "operating_expense", range: [6000, 7000] },
  "Other Expense": { subcategory: "other_expense", range: [7000, 8000] },
};

const COGS_BY_SUBTYPE: Record<string, Account["subcategory"]> = {
  CostOfLaborCos: "cogs_labor",
  EquipmentRentalCos: "cogs_equipment",
  OtherCostsOfServiceCos: "cogs_other",
  ShippingFreightDeliveryCos: "cogs_other",
};

/** QuickBooks accounts that take over a Groundworks system account (the first of each). */
function systemCode(r: QboRecord): string | null {
  const type = r.AccountType as string;
  const sub = r.AccountSubType as string | undefined;
  if (type === "Accounts Receivable") return "1200";
  if (type === "Accounts Payable") return "2000";
  if (sub === "UndepositedFunds") return "1250";
  if (sub === "Inventory") return "1300";
  if (sub === "SalesTaxPayable" || sub === "GlobalTaxPayable") return "2200";
  if (sub === "OpeningBalanceEquity") return "3300";
  if (sub === "RetainedEarnings") return "3200";
  if (sub === "DiscountsRefundsGiven") return "4950";
  return null;
}

/** Groundworks accounts the app looks up by number: never deactivated. */
const LOAD_BEARING = new Set(["1200", "1250", "2000", "2200", "3200", "3300", "4930", "4940", "4950", "7400"]);

const BALANCE_SHEET = new Set<string>([
  "cash", "receivables", "inventory", "other_current_asset", "fixed_assets", "other_asset",
  "payables", "accrued_liabilities", "other_current_liability", "lt_debt", "other_liability", "equity", "retained_earnings",
]);
const CREDIT = new Set<string>(["payables", "accrued_liabilities", "other_current_liability", "lt_debt", "other_liability", "equity", "retained_earnings", "operating_revenue", "other_revenue"]);

function shapeOf(r: QboRecord): Shape {
  const base = BY_TYPE[r.AccountType as string] ?? BY_TYPE.Expense;
  const sub = r.AccountSubType as string | undefined;
  if (r.AccountType === "Other Current Asset" && sub === "Inventory") return { ...base, subcategory: "inventory" };
  if (r.AccountType === "Cost of Goods Sold" && sub && COGS_BY_SUBTYPE[sub]) return { ...base, subcategory: COGS_BY_SUBTYPE[sub] };
  return base;
}

function normalBalanceOf(r: QboRecord, subcategory: Account["subcategory"]): Account["normalBalance"] {
  const sub = String(r.AccountSubType ?? "");
  // Contra accounts: draws, distributions, accumulated depreciation, discounts given.
  if (/Draw|Distribution/.test(sub)) return "debit";
  if (/AccumulatedDepreciation|AccumulatedAmortization/.test(sub)) return "credit";
  if (sub === "DiscountsRefundsGiven") return "debit";
  return CREDIT.has(subcategory) ? "credit" : "debit";
}

const depth = (r: QboRecord) => String(r.FullyQualifiedName ?? r.Name ?? "").split(":").length - 1;

export const accountsStep: Step = {
  key: "accounts",
  label: "Chart of accounts",
  async run(kit: Kit) {
    await kit.preload("Account");
    const all: QboRecord[] = [];
    for (let pos = 1; ; pos += PAGE_SIZE) {
      const rows = await kit.client.page("Account", pos, "Active in (true, false)");
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    const existing = await kit.ctx.tx.select().from(accounts).where(eq(accounts.organizationId, kit.org));
    const byCode = new Map(existing.map((a) => [a.code, a]));
    const taken = new Set(existing.map((a) => a.code));
    const claimed = new Set<string>();
    const byQboId = new Map(all.map((r) => [r.Id, r]));

    /** Right after the parent for a sub-account, else the next free round number in the type's range. */
    const freeCode = (range: [number, number], near?: string): string => {
      if (near) {
        for (let n = Number(near) + 1; n < range[1]; n++) if (!taken.has(String(n))) return String(n);
      }
      for (const step of [10, 1]) {
        for (let n = range[0]; n < range[1]; n += step) if (!taken.has(String(n))) return String(n);
      }
      for (let n = 1; ; n++) if (!taken.has(`${range[0]}-${n}`)) return `${range[0]}-${n}`;
    };

    for (const r of [...all].sort((a, b) => depth(a) - depth(b))) {
      if (await kit.mapped("Account", r.Id)) continue;
      const name = String(r.Name ?? r.FullyQualifiedName ?? "Account").slice(0, 200);
      const sys = systemCode(r);
      const own = sys && !claimed.has(sys) ? byCode.get(sys) : undefined;
      if (own) {
        claimed.add(sys!);
        await kit.ctx.tx
          .update(accounts)
          .set({ name, description: (r.Description as string) ?? own.description, isActive: true, updatedAt: sql`now()` })
          .where(eq(accounts.id, own.id));
        await kit.remember("Account", r.Id, own.id);
        if (r.AcctNum && r.AcctNum !== sys) kit.note(`${name} is numbered ${sys} here (it was ${r.AcctNum as string} in QuickBooks): Groundworks finds this account by its number.`);
        kit.count("accounts", "imported");
        continue;
      }
      const shape = shapeOf(r);
      const parent = (r.ParentRef as Ref)?.value ? byQboId.get((r.ParentRef as Ref)!.value!) : undefined;
      const parentLocal = parent ? await kit.local("Account", { value: parent.Id }) : null;
      const parentCode = parentLocal ? existing.find((a) => a.id === parentLocal)?.code : undefined;
      let code = typeof r.AcctNum === "string" && r.AcctNum.trim() ? r.AcctNum.trim().slice(0, 32) : null;
      if (code && taken.has(code)) {
        const holder = byCode.get(code);
        if (holder && !LOAD_BEARING.has(code) && !(await isMappedLocal(kit, holder.id))) {
          // A default account sits on the number: move it aside (it's deactivated at the end).
          const aside = `D${code}`;
          await kit.ctx.tx.update(accounts).set({ code: aside, updatedAt: sql`now()` }).where(eq(accounts.id, holder.id));
          taken.delete(code);
          taken.add(aside);
          byCode.delete(code);
          byCode.set(aside, { ...holder, code: aside });
        } else {
          const fresh = freeCode(shape.range);
          kit.note(`${name} is numbered ${fresh}: its QuickBooks number ${code} is used by ${holder?.name ?? "another account"}.`);
          code = fresh;
        }
      }
      code ??= parentCode && /^\d+$/.test(parentCode) ? freeCode(shape.range, parentCode) : freeCode(shape.range);
      const [row] = await kit.ctx.tx
        .insert(accounts)
        .values({
          organizationId: kit.org,
          code,
          name,
          description: (r.Description as string) ?? null,
          category: BALANCE_SHEET.has(shape.subcategory) ? "balance_sheet" : "income_statement",
          subcategory: shape.subcategory,
          normalBalance: normalBalanceOf(r, shape.subcategory),
          isCash: shape.isCash ?? false,
          isReconciliation: shape.isReconciliation ?? false,
          indentation: depth(r),
          isActive: r.Active !== false,
        })
        .returning();
      taken.add(code);
      byCode.set(code, row);
      existing.push(row);
      await kit.remember("Account", r.Id, row.id);
      kit.count("accounts", "imported");
    }

    // Groundworks' defaults that nothing maps to step aside.
    const mappedIds = new Set(
      (await kit.ctx.tx.execute<{ local_id: string }>(sql`SELECT local_id FROM qbo_id_map WHERE organization_id = ${kit.org} AND entity = 'Account'`)).map(
        (r) => r.local_id
      )
    );
    const unused = existing.filter((a) => !mappedIds.has(a.id) && !LOAD_BEARING.has(a.code) && a.isActive);
    for (const a of unused) {
      await kit.ctx.tx.update(accounts).set({ isActive: false, updatedAt: sql`now()` }).where(and(eq(accounts.id, a.id), eq(accounts.organizationId, kit.org)));
    }
    await writeAudit(
      {
        organizationId: kit.org,
        ...auditFields(kit.ctx.actor),
        event: "qbo.import.accounts",
        entityType: "organization",
        entityId: kit.org,
        metadata: { fromQuickBooks: all.length, defaultsDeactivated: unused.length },
      },
      kit.ctx.tx
    );
    return { done: true, position: 1 };
  },
};

async function isMappedLocal(kit: Kit, localId: string): Promise<boolean> {
  const [r] = await kit.ctx.tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM qbo_id_map WHERE organization_id = ${kit.org} AND entity = 'Account' AND local_id = ${localId}`
  );
  return (r?.n ?? 0) > 0;
}
