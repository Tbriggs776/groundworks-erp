import type { NewAccount } from "@/lib/db/schema";

/**
 * Default small-business Chart of Accounts. ~60 accounts shaped like the
 * QuickBooks Online defaults most owners and bookkeepers already know, so
 * migrating from QBO is a mapping exercise rather than a redesign.
 *
 * Ranges:
 *   1xxx — Assets
 *   2xxx — Liabilities
 *   3xxx — Equity
 *   4xxx — Income
 *   5xxx — Cost of Goods Sold
 *   6xxx — Operating Expenses
 *   7xxx — Other Expense
 *
 * Some codes are load-bearing — subledgers look them up by code:
 *   1200 AR control, 2000 AP control (found via isControl + subcategory)
 *   1250 Undeposited Funds (default deposit-to for customer payments)
 *   4930 / 7400 FX gain / loss (revaluation)
 *   4940 Purchase Discounts Earned (AP early-pay discounts)
 *   4950 Sales Discounts (AR early-pay discounts given)
 *
 * Contract labor, contractors, and professional fees report on 1099-NEC
 * box 1; rents (equipment and premises) on 1099-MISC box 1.
 *
 * Consumed by `seedOrganizationDefaults`; each row becomes one `accounts`
 * INSERT.
 */

type AccountSeed = Omit<
  NewAccount,
  "id" | "organizationId" | "createdAt" | "updatedAt" | "deletedAt"
>;

export const DEFAULT_COA: AccountSeed[] = [
  // --- ASSETS ---
  { code: "1010", name: "Checking", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true, isReconciliation: true },
  { code: "1020", name: "Savings", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true, isReconciliation: true },
  { code: "1040", name: "Petty Cash", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true },
  { code: "1200", name: "Accounts Receivable", category: "balance_sheet", subcategory: "receivables", normalBalance: "debit", isControl: true, directPosting: false },
  { code: "1230", name: "Allowance for Doubtful Accounts", category: "balance_sheet", subcategory: "receivables", normalBalance: "credit", description: "Contra-asset" },
  { code: "1250", name: "Undeposited Funds", category: "balance_sheet", subcategory: "cash", normalBalance: "debit", isCash: true, description: "Customer payments received but not yet deposited to a bank account" },
  { code: "1300", name: "Inventory Asset", category: "balance_sheet", subcategory: "inventory", normalBalance: "debit" },
  { code: "1400", name: "Prepaid Expenses", category: "balance_sheet", subcategory: "other_current_asset", normalBalance: "debit" },
  { code: "1410", name: "Prepaid Insurance", category: "balance_sheet", subcategory: "other_current_asset", normalBalance: "debit" },
  { code: "1500", name: "Furniture & Equipment", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1510", name: "Vehicles", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1520", name: "Computers & Software", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1530", name: "Buildings & Leasehold Improvements", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "debit" },
  { code: "1590", name: "Accumulated Depreciation", category: "balance_sheet", subcategory: "fixed_assets", normalBalance: "credit", description: "Contra-asset" },
  { code: "1900", name: "Security Deposits", category: "balance_sheet", subcategory: "other_asset", normalBalance: "debit" },

  // --- LIABILITIES ---
  { code: "2000", name: "Accounts Payable", category: "balance_sheet", subcategory: "payables", normalBalance: "credit", isControl: true, directPosting: false },
  { code: "2100", name: "Credit Card", category: "balance_sheet", subcategory: "other_current_liability", normalBalance: "credit", isReconciliation: true },
  { code: "2200", name: "Sales Tax Payable", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2210", name: "Payroll Liabilities", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2220", name: "Accrued Expenses", category: "balance_sheet", subcategory: "accrued_liabilities", normalBalance: "credit" },
  { code: "2300", name: "Customer Deposits", category: "balance_sheet", subcategory: "other_current_liability", normalBalance: "credit", description: "Unearned revenue / prepayments from customers" },
  { code: "2400", name: "Line of Credit", category: "balance_sheet", subcategory: "other_current_liability", normalBalance: "credit" },
  { code: "2500", name: "Loans Payable", category: "balance_sheet", subcategory: "lt_debt", normalBalance: "credit" },
  { code: "2900", name: "Other Liabilities", category: "balance_sheet", subcategory: "other_liability", normalBalance: "credit" },

  // --- EQUITY ---
  { code: "3000", name: "Owner's Equity", category: "balance_sheet", subcategory: "equity", normalBalance: "credit" },
  { code: "3100", name: "Owner's Investment", category: "balance_sheet", subcategory: "equity", normalBalance: "credit" },
  { code: "3200", name: "Retained Earnings", category: "balance_sheet", subcategory: "retained_earnings", normalBalance: "credit" },
  { code: "3300", name: "Opening Balance Equity", category: "balance_sheet", subcategory: "equity", normalBalance: "credit", description: "Offset for opening balances during migration" },
  { code: "3400", name: "Owner's Draw / Distributions", category: "balance_sheet", subcategory: "equity", normalBalance: "debit", description: "Contra-equity" },

  // --- INCOME ---
  { code: "4000", name: "Sales", category: "income_statement", subcategory: "operating_revenue", normalBalance: "credit" },
  { code: "4100", name: "Services", category: "income_statement", subcategory: "operating_revenue", normalBalance: "credit" },
  { code: "4200", name: "Shipping & Delivery Income", category: "income_statement", subcategory: "operating_revenue", normalBalance: "credit" },
  { code: "4900", name: "Other Income", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit" },
  { code: "4910", name: "Interest Income", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit" },
  { code: "4930", name: "Unrealized FX Gain", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit", description: "Period-end revaluation gain on foreign-currency balances" },
  { code: "4940", name: "Purchase Discounts Earned", category: "income_statement", subcategory: "other_revenue", normalBalance: "credit", description: "Early-pay discounts taken on bills" },
  { code: "4950", name: "Sales Discounts", category: "income_statement", subcategory: "operating_revenue", normalBalance: "debit", description: "Contra-revenue: early-pay discounts given to customers" },

  // --- COST OF GOODS SOLD ---
  { code: "5000", name: "Cost of Labor", category: "income_statement", subcategory: "cogs_labor", normalBalance: "debit" },
  { code: "5100", name: "Supplies & Materials", category: "income_statement", subcategory: "cogs_materials", normalBalance: "debit" },
  { code: "5200", name: "Equipment Rental", category: "income_statement", subcategory: "cogs_equipment", normalBalance: "debit", form1099Box: "misc_1" },
  { code: "5300", name: "Contract Labor", category: "income_statement", subcategory: "cogs_subcontractor", normalBalance: "debit", form1099Box: "nec_1" },
  { code: "5400", name: "Shipping & Freight", category: "income_statement", subcategory: "cogs_other", normalBalance: "debit" },
  { code: "5900", name: "Other Costs of Goods Sold", category: "income_statement", subcategory: "cogs_other", normalBalance: "debit" },

  // --- OPERATING EXPENSES ---
  { code: "6000", name: "Advertising & Marketing", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6050", name: "Auto & Travel", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6100", name: "Bank & Merchant Fees", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6150", name: "Contractors", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit", form1099Box: "nec_1", description: "1099 contractors not tied to cost of sales" },
  { code: "6200", name: "Dues & Subscriptions", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6250", name: "Software & SaaS", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6300", name: "Insurance", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6350", name: "Legal & Professional Fees", category: "income_statement", subcategory: "sga", normalBalance: "debit", form1099Box: "nec_1" },
  { code: "6400", name: "Meals", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6500", name: "Payroll Expenses", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6510", name: "Payroll Taxes", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6520", name: "Employee Benefits", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6600", name: "Rent & Lease", category: "income_statement", subcategory: "sga", normalBalance: "debit", form1099Box: "misc_1" },
  { code: "6610", name: "Utilities", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6620", name: "Office Supplies", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6630", name: "Telephone & Internet", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6680", name: "Repairs & Maintenance", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit" },
  { code: "6690", name: "Training & Education", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6700", name: "Depreciation Expense", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6800", name: "Bad Debt Expense", category: "income_statement", subcategory: "sga", normalBalance: "debit" },
  { code: "6900", name: "Uncategorized Expense", category: "income_statement", subcategory: "operating_expense", normalBalance: "debit", description: "Holding account; reclass before close" },

  // --- OTHER EXPENSE ---
  { code: "7000", name: "Interest Expense", category: "income_statement", subcategory: "interest", normalBalance: "debit" },
  { code: "7100", name: "Income Taxes", category: "income_statement", subcategory: "tax", normalBalance: "debit" },
  { code: "7200", name: "Penalties & Fines", category: "income_statement", subcategory: "other_expense", normalBalance: "debit" },
  { code: "7300", name: "Loss on Sale of Assets", category: "income_statement", subcategory: "other_expense", normalBalance: "debit" },
  { code: "7400", name: "Unrealized FX Loss", category: "income_statement", subcategory: "other_expense", normalBalance: "debit", description: "Period-end revaluation loss on foreign-currency balances" },
  { code: "7900", name: "Other Expenses", category: "income_statement", subcategory: "other_expense", normalBalance: "debit" },
];
