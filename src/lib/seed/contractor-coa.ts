import type { NewAccount } from "@/lib/db/schema";

/**
 * Standard mid-market contractor Chart of Accounts. ~70 accounts covering
 * a typical general contractor / specialty subcontractor structure.
 *
 * Based on AGC / CFMA best-practice contractor CoA conventions with
 * construction-specific items: Retainage Receivable / Payable, WIP,
 * Billings in Excess / Costs in Excess, union benefits accruals.
 *
 * Ranges:
 *   1xxx — Assets
 *   2xxx — Liabilities
 *   3xxx — Equity
 *   4xxx — Revenue
 *   5xxx — Direct Costs (COGS)
 *   6xxx — Overhead + SG&A
 *   7xxx — Other Expense
 *
 * Consumed by `seedContractorCoa(orgId, tx)`; each row becomes one
 * `accounts` INSERT.
 */

type AccountSeed = Omit<
  NewAccount,
  "id" | "organizationId" | "createdAt" | "updatedAt" | "deletedAt"
>;

export const CONTRACTOR_COA: AccountSeed[] = [
  // --- ASSETS ---
  { code: "1010", name: "Cash — Operating", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true, isReconciliation: true },
  { code: "1020", name: "Cash — Payroll", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true, isReconciliation: true },
  { code: "1030", name: "Cash — Money Market", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true, isReconciliation: true },
  { code: "1040", name: "Petty Cash", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true },
  { code: "1200", name: "Accounts Receivable — Trade", category: "balance_sheet", subcategory: "receivables", normalBalance: "debit", isControl: true, directPosting: false },
  { code: "1210", name: "Retainage Receivable", category: "balance_sheet", subcategory: "receivables", normalBalance: "debit" },
  { code: "1220", name: "Costs in Excess of Billings (Unbilled)", category: "balance_sheet", subcategory: "receivables", normalBalance: "debit" },
  { code: "1230", name: "Allowance for Doubtful Accounts", category: "balance_sheet", subcategory: "receivables", normalBalance: "credit", description: "Contra-asset" },
  { code: "1300", name: "Inventory — Materials", category: "balance_sheet", subcategory: "inventory", normalBalance: "debit", isControl: true, directPosting: false },
  { code: "1310", name: "Work in Progress — Contract Costs", category: "balance_sheet", subcategory: "inventory", normalBalance: "debit" },
  { code: "1400", name: "Prepaid Insurance", category: "balance_sheet", subcategory: "other_current_asset", normalBalance: "debit" },
  { code: "1410", name: "Prepaid Bonds", category: "balance_sheet", subcategory: "other_current_asset", normalBalance: "debit" },
  { code: "1420", name: "Other Prepaid Expenses", category: "balance_sheet", subcategory: "other_current_asset", normalBalance: "debit" },
  { code: "1500", name: "Property, Plant & Equipment — Equipment", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1510", name: "PP&E — Vehicles", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1520", name: "PP&E — Buildings", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1530", name: "PP&E — Land", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1550", name: "Accumulated Depreciation — Equipment", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "credit", description: "Contra-asset" },
  { code: "1560", name: "Accumulated Depreciation — Vehicles", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "credit", description: "Contra-asset" },
  { code: "1570", name: "Accumulated Depreciation — Buildings", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "credit", description: "Contra-asset" },
  { code: "1900", name: "Other Assets", category: "balance_sheet", subcategory: "other_asset", normalBalance: "debit" },

  // --- LIABILITIES ---
  { code: "2000", name: "Accounts Payable — Trade", category: "balance_sheet", subcategory: "payables", normalBalance: "credit", isControl: true, directPosting: false },
  { code: "2010", name: "Retainage Payable", category: "balance_sheet", subcategory: "payables", normalBalance: "credit" },
  { code: "2020", name: "Accrued Payroll", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2030", name: "Accrued Payroll Taxes", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2040", name: "Accrued Union Benefits", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2050", name: "Sales Tax Payable", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2060", name: "Other Accrued Expenses", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2070", name: "Billings in Excess of Costs (Overbilling)", category: "balance_sheet", subcategory: "other_current_liability", normalBalance: "credit" },
  { code: "2100", name: "Line of Credit", category: "balance_sheet", subcategory: "other_current_liability", normalBalance: "credit" },
  { code: "2200", name: "Equipment Loans — Current Portion", category: "balance_sheet", subcategory: "other_current_liability", normalBalance: "credit" },
  { code: "2210", name: "Notes Payable — Current Portion", category: "balance_sheet", subcategory: "other_current_liability", normalBalance: "credit" },
  { code: "2500", name: "Equipment Loans — Long-Term", category: "balance_sheet", subcategory: "lt_debt", normalBalance: "credit" },
  { code: "2510", name: "Notes Payable — Long-Term", category: "balance_sheet", subcategory: "lt_debt", normalBalance: "credit" },
  { code: "2520", name: "Mortgage Payable", category: "balance_sheet", subcategory: "lt_debt", normalBalance: "credit" },
  { code: "2900", name: "Other Liabilities", category: "balance_sheet", subcategory: "other_liability", normalBalance: "credit" },

  // --- EQUITY ---
  { code: "3000", name: "Common Stock / Member Equity", category: "balance_sheet", subcategory: "equity", normalBalance: "credit" },
  { code: "3100", name: "Additional Paid-In Capital", category: "balance_sheet", subcategory: "equity", normalBalance: "credit" },
  { code: "3200", name: "Retained Earnings", category: "balance_sheet", subcategory: "retained_earnings", normalBalance: "credit" },
  { code: "3300", name: "Current Year Earnings", category: "balance_sheet", subcategory: "retained_earnings", normalBalance: "credit", description: "System-managed, populated at year-end close" },
  { code: "3400", name: "Distributions / Dividends", category: "balance_sheet", subcategory: "equity", normalBalance: "debit", description: "Contra-equity" },

  // --- REVENUE ---
  { code: "4000", name: "Contract Revenue", category: "income_statement", subcategory: "operating_revenue", normalBalance: "credit" },
  { code: "4010", name: "Change Order Revenue", category: "income_statement", subcategory: "operating_revenue", normalBalance: "credit" },
  { code: "4020", name: "Time & Materials Revenue", category: "income_statement", subcategory: "operating_revenue", normalBalance: "credit" },
  { code: "4100", name: "Service Revenue", category: "income_statement", subcategory: "operating_revenue", normalBalance: "credit" },
  { code: "4900", name: "Other Income", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit" },
  { code: "4910", name: "Interest Income", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit" },
  { code: "4920", name: "Gain on Sale of Assets", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit" },
  { code: "4930", name: "Unrealized FX Gain", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit", description: "Period-end revaluation gain on foreign-currency balances" },

  // --- COGS / DIRECT COSTS ---
  { code: "5000", name: "Direct Labor", category: "income_statement", subcategory: "cogs_labor", normalBalance: "debit" },
  { code: "5010", name: "Labor Burden — Direct", category: "income_statement", subcategory: "cogs_labor", normalBalance: "debit" },
  { code: "5100", name: "Materials", category: "income_statement", subcategory: "cogs_materials", normalBalance: "debit" },
  { code: "5200", name: "Equipment — Owned (Usage)", category: "income_statement", subcategory: "cogs_equipment", normalBalance: "debit" },
  { code: "5210", name: "Equipment — Rented", category: "income_statement", subcategory: "cogs_equipment", normalBalance: "debit" },
  { code: "5300", name: "Subcontracts", category: "income_statement", subcategory: "cogs_subcontractor", normalBalance: "debit" },
  { code: "5400", name: "Other Direct Costs", category: "income_statement", subcategory: "cogs_other", normalBalance: "debit" },
  { code: "5500", name: "Job Insurance", category: "income_statement", subcategory: "cogs_other", normalBalance: "debit" },
  { code: "5600", name: "Project-Specific Costs", category: "income_statement", subcategory: "cogs_other", normalBalance: "debit" },

  // --- OVERHEAD ---
  { code: "6000", name: "Indirect Labor", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6010", name: "Indirect Labor Burden", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6050", name: "Small Tools & Consumables", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6060", name: "Field Supervision", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6100", name: "Vehicle Expense", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6200", name: "Fuel", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6300", name: "Job Supplies", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6400", name: "Equipment Maintenance", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },

  // --- SG&A ---
  { code: "6500", name: "Office Salaries", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6510", name: "Officer Salaries", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6550", name: "Payroll Taxes — SG&A", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6560", name: "Employee Benefits", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6600", name: "Rent", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6610", name: "Utilities", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6620", name: "Office Supplies", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6630", name: "Telephone / Internet", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6640", name: "Office Insurance", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6650", name: "Legal & Professional Fees", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6660", name: "Bank Fees", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6670", name: "Travel & Entertainment", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6680", name: "Marketing / Advertising", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6690", name: "Training & Education", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6700", name: "Depreciation Expense", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6710", name: "Dues & Subscriptions", category: "income_statement", subcategory: "sga", normalBalance: "debit" },

  // --- OTHER EXPENSE ---
  { code: "7000", name: "Interest Expense", category: "income_statement", subcategory: "interest", normalBalance: "debit" },
  { code: "7100", name: "State Income Tax", category: "income_statement", subcategory: "tax", normalBalance: "debit" },
  { code: "7110", name: "Federal Income Tax", category: "income_statement", subcategory: "tax", normalBalance: "debit" },
  { code: "7200", name: "Penalties & Fines", category: "income_statement", subcategory: "other_expense", normalBalance: "debit" },
  { code: "7300", name: "Loss on Sale of Assets", category: "income_statement", subcategory: "other_expense", normalBalance: "debit" },
  { code: "7400", name: "Unrealized FX Loss", category: "income_statement", subcategory: "other_expense", normalBalance: "debit", description: "Period-end revaluation loss on foreign-currency balances" },
  { code: "7900", name: "Other Expenses", category: "income_statement", subcategory: "other_expense", normalBalance: "debit" },
];
