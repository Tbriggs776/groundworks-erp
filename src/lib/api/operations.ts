import { z } from "zod";
import type { Ctx, Scope } from "@/lib/actor";
import * as billPayments from "@/lib/ap/bill-payments";
import * as bills from "@/lib/ap/bills";
import * as invoices from "@/lib/ar/invoices";
import * as items from "@/lib/ar/items";
import * as customerPayments from "@/lib/ar/payments";
import { ListActivitySchema, listActivity } from "@/lib/audit-query";
import * as accounts from "@/lib/gl/accounts";
import * as journals from "@/lib/gl/journals";
import { listDimensions, listPeriods, ListPeriodsSchema, whoami } from "@/lib/gl/reference";
import * as parties from "@/lib/parties/service";
import { AgingSchema, apAging, arAging } from "@/lib/reports/aging";
import * as financial from "@/lib/reports/financial";
import { listReviewQueue } from "@/lib/review";
import { id, isoDate } from "@/lib/schemas";

/**
 * THE OPERATION REGISTRY — one list, three surfaces:
 *
 *   REST     /api/v1/<path>          (src/lib/api/rest.ts)
 *   MCP      tools/list, tools/call  (src/lib/api/mcp.ts)
 *   OpenAPI  /api/v1/openapi.json    (src/lib/api/openapi.ts)
 *
 * Each operation names a service function; the service does validation,
 * permission checks (role + scope), and auditing. `scope` here is for docs
 * and for hiding tools an agent can't use — never the security boundary.
 *
 * Descriptions are read by AI agents deciding which tool to call. Say what
 * it does, when to use it, and what to watch out for.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type Operation = {
  name: string;
  title: string;
  description: string;
  group: "Context" | "Accounting" | "Sales" | "Expenses" | "Reports" | "Review";
  method: HttpMethod;
  path: string;
  scope: Scope;
  /** Destructive = voids, reversals, deletes. Drives MCP annotations. */
  destructive?: boolean;
  input: z.ZodType;
  run: (ctx: Ctx, input: unknown) => Promise<unknown>;
};

function op<S extends z.ZodType>(def: Omit<Operation, "input" | "run"> & {
  input: S;
  run: (ctx: Ctx, input: z.input<S>) => Promise<unknown>;
}): Operation {
  // Services re-parse their own input, so passing the raw value through is
  // safe; the schema here is what callers see in OpenAPI / MCP.
  return { ...def, run: (ctx, input) => def.run(ctx, input as z.input<S>) };
}

const Empty = z.object({});
const ById = z.object({ id });
const Void = z.object({
  id,
  reason: z.string().trim().min(1).max(500).describe("Why it's being voided. Kept in the audit trail."),
});

const POSTING_NOTE =
  "Pass post=true to finalize in one call; that needs the post scope, and agents with a posting limit get approval_required for larger amounts (the draft is kept for human review).";

export const OPERATIONS: Operation[] = [
  // ---------------------------------------------------------------- Context
  op({
    name: "whoami",
    title: "Who am I",
    description:
      "Your organization (name, base currency, fiscal year) and your own permissions: role, scopes (read / write / post), and any posting limit. Call this first in a session so you know whether you can post or only draft.",
    group: "Context",
    method: "GET",
    path: "/me",
    scope: "read",
    input: Empty,
    run: (ctx) => whoami(ctx),
  }),
  op({
    name: "list_periods",
    title: "List fiscal periods",
    description:
      "Monthly fiscal periods with their status (open, soft_closed, hard_closed). Postings must fall in an open period; check here when a post fails with a period error.",
    group: "Context",
    method: "GET",
    path: "/periods",
    scope: "read",
    input: ListPeriodsSchema,
    run: (ctx, input) => listPeriods(ctx, input),
  }),
  op({
    name: "list_dimensions",
    title: "List classes, locations, departments, projects",
    description:
      "Analytical tags (QuickBooks' classes and locations) and their values. Use the dimensionId + valueId pairs in the `dimensions` field of invoice lines and journal lines.",
    group: "Context",
    method: "GET",
    path: "/dimensions",
    scope: "read",
    input: Empty,
    run: (ctx) => listDimensions(ctx),
  }),

  // ------------------------------------------------------------- Accounting
  op({
    name: "list_accounts",
    title: "List chart of accounts",
    description:
      "The chart of accounts. Filter with q (code or name), category, subcategory, or cashOnly for bank accounts. Set withBalances=true to include balances (signed in each account's normal direction). Use this to find account ids for bills, items, and journal entries.",
    group: "Accounting",
    method: "GET",
    path: "/accounts",
    scope: "read",
    input: accounts.ListAccountsSchema,
    run: (ctx, input) => accounts.listAccounts(ctx, input),
  }),
  op({
    name: "get_account",
    title: "Get an account and its balance",
    description:
      "One account with its balance as of a date (default today). Balance is positive in the account's normal direction: cash on hand for a bank account, revenue for an income account.",
    group: "Accounting",
    method: "GET",
    path: "/accounts/{id}",
    scope: "read",
    input: z.object({ id, asOf: isoDate.optional() }),
    run: (ctx, input) => accounts.getAccount(ctx, input),
  }),
  op({
    name: "create_account",
    title: "Create an account",
    description:
      "Add an account to the chart. Pick the subcategory carefully (it decides balance sheet vs P&L and the normal balance). Requires the accountant role.",
    group: "Accounting",
    method: "POST",
    path: "/accounts",
    scope: "write",
    input: accounts.CreateAccountSchema,
    run: (ctx, input) => accounts.createAccount(ctx, input),
  }),
  op({
    name: "list_journal_entries",
    title: "List journal entries",
    description:
      "General ledger journals, newest first: manual entries plus the journals invoices, bills, and payments create. Filter by status, source, date range, or q.",
    group: "Accounting",
    method: "GET",
    path: "/journal-entries",
    scope: "read",
    input: journals.ListJournalsSchema,
    run: (ctx, input) => journals.listJournals(ctx, input),
  }),
  op({
    name: "get_journal_entry",
    title: "Get a journal entry",
    description: "One journal with its lines (account, debit, credit, memo, tags).",
    group: "Accounting",
    method: "GET",
    path: "/journal-entries/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => journals.getJournal(ctx, input),
  }),
  op({
    name: "create_journal_entry",
    title: "Create a journal entry",
    description: `A manual double-entry journal: at least two lines, each with a debit OR a credit, debits equal to credits. Use for adjustments, accruals, reclasses, and opening balances; use invoices / bills / payments for everyday transactions so subledgers stay right. Control accounts (AR, AP) can't be used here. Saved as a draft unless post=true. ${POSTING_NOTE}`,
    group: "Accounting",
    method: "POST",
    path: "/journal-entries",
    scope: "write",
    input: journals.CreateJournalEntrySchema,
    run: (ctx, input) => journals.createJournalEntry(ctx, input),
  }),
  op({
    name: "post_journal_entry",
    title: "Post a draft journal entry",
    description: "Post a draft manual journal to the ledger. Runs every posting validation (balance, open period, account rules).",
    group: "Accounting",
    method: "POST",
    path: "/journal-entries/{id}/post",
    scope: "post",
    input: ById,
    run: (ctx, input) => journals.postJournalEntry(ctx, input),
  }),
  op({
    name: "reverse_journal_entry",
    title: "Reverse a posted journal entry",
    description:
      "Correct a posted manual journal by posting its mirror image. Posted entries are never edited. For invoices, bills, and payments, void the document instead. Only do this when asked.",
    group: "Accounting",
    method: "POST",
    path: "/journal-entries/{id}/reverse",
    scope: "post",
    destructive: true,
    input: journals.ReverseJournalSchema,
    run: (ctx, input) => journals.reverseJournalEntry(ctx, input),
  }),
  op({
    name: "delete_journal_entry",
    title: "Delete a draft journal entry",
    description: "Discard a draft manual journal. Posted journals can only be reversed.",
    group: "Accounting",
    method: "DELETE",
    path: "/journal-entries/{id}",
    scope: "write",
    destructive: true,
    input: ById,
    run: (ctx, input) => journals.deleteDraftJournal(ctx, input),
  }),

  // ------------------------------------------------------------------ Sales
  op({
    name: "list_customers",
    title: "List / search customers",
    description:
      "Customers with their open AR balance. Search with q (name, code, or email) before creating one, to avoid duplicates.",
    group: "Sales",
    method: "GET",
    path: "/customers",
    scope: "read",
    input: parties.ListPartiesSchema,
    run: (ctx, input) => parties.listCustomers(ctx, input),
  }),
  op({
    name: "get_customer",
    title: "Get a customer",
    description: "One customer, including open balance, terms, and contact details.",
    group: "Sales",
    method: "GET",
    path: "/customers/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => parties.getCustomer(ctx, input),
  }),
  op({
    name: "create_customer",
    title: "Create a customer",
    description:
      "Add a customer. Only name is required; the code is derived from the name. Search first with list_customers so you don't create a duplicate.",
    group: "Sales",
    method: "POST",
    path: "/customers",
    scope: "write",
    input: parties.CreateCustomerSchema,
    run: (ctx, input) => parties.createCustomer(ctx, input),
  }),
  op({
    name: "update_customer",
    title: "Update a customer",
    description: "Change fields on a customer. Only the fields you send change; send null or \"\" to clear a text field.",
    group: "Sales",
    method: "PATCH",
    path: "/customers/{id}",
    scope: "write",
    input: parties.UpdateCustomerSchema,
    run: (ctx, input) => parties.updateCustomer(ctx, input),
  }),
  op({
    name: "list_items",
    title: "List products & services",
    description: "What the business sells, with default prices and income accounts. Search with q.",
    group: "Sales",
    method: "GET",
    path: "/items",
    scope: "read",
    input: items.ListItemsSchema,
    run: (ctx, input) => items.listItems(ctx, input),
  }),
  op({
    name: "get_item",
    title: "Get a product or service",
    description: "One product or service.",
    group: "Sales",
    method: "GET",
    path: "/items/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => items.getItem(ctx, input),
  }),
  op({
    name: "create_item",
    title: "Create a product or service",
    description:
      "Add something the business sells. Give it an income account (e.g. 4100 Services) and usually a sales price so invoice lines can be just { itemId, quantity }.",
    group: "Sales",
    method: "POST",
    path: "/items",
    scope: "write",
    input: items.CreateItemSchema,
    run: (ctx, input) => items.createItem(ctx, input),
  }),
  op({
    name: "update_item",
    title: "Update a product or service",
    description: "Change fields on a product or service. Only the fields you send change.",
    group: "Sales",
    method: "PATCH",
    path: "/items/{id}",
    scope: "write",
    input: items.UpdateItemSchema,
    run: (ctx, input) => items.updateItem(ctx, input),
  }),
  op({
    name: "list_invoices",
    title: "List invoices",
    description:
      "Invoices with customer name and open balance. Filter by status (draft, open, paid, voided), customerId, overdueOnly, date range, or q.",
    group: "Sales",
    method: "GET",
    path: "/invoices",
    scope: "read",
    input: invoices.ListInvoicesSchema,
    run: (ctx, input) => invoices.listInvoices(ctx, input),
  }),
  op({
    name: "get_invoice",
    title: "Get an invoice",
    description: "One invoice with lines, open balance, and the payments applied to it.",
    group: "Sales",
    method: "GET",
    path: "/invoices/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => invoices.getInvoice(ctx, input),
  }),
  op({
    name: "create_invoice",
    title: "Create an invoice",
    description: `Bill a customer. Each line is either { itemId, quantity } (price, description, and income account come from the item) or explicit { description, quantity, unitPrice, accountId }. A negative unitPrice makes a discount line. Due date defaults from the customer's terms. Saved as a draft unless post=true; posting books Dr Accounts Receivable / Cr income. ${POSTING_NOTE}`,
    group: "Sales",
    method: "POST",
    path: "/invoices",
    scope: "write",
    input: invoices.CreateInvoiceSchema,
    run: (ctx, input) => invoices.createInvoice(ctx, input),
  }),
  op({
    name: "update_invoice",
    title: "Update a draft invoice",
    description: "Replace a draft invoice's header and lines. Posted invoices can't be edited; void and re-issue instead.",
    group: "Sales",
    method: "PATCH",
    path: "/invoices/{id}",
    scope: "write",
    input: invoices.UpdateInvoiceSchema,
    run: (ctx, input) => invoices.updateInvoice(ctx, input),
  }),
  op({
    name: "post_invoice",
    title: "Post (finalize) an invoice",
    description: "Finalize a draft invoice: it becomes open and hits the ledger (Dr AR / Cr income).",
    group: "Sales",
    method: "POST",
    path: "/invoices/{id}/post",
    scope: "post",
    input: ById,
    run: (ctx, input) => invoices.postInvoice(ctx, input),
  }),
  op({
    name: "void_invoice",
    title: "Void an invoice",
    description:
      "Void an open invoice with no payments: posts a reversing entry and marks it voided. Void its payments first if any. Requires admin, so agents can't do this.",
    group: "Sales",
    method: "POST",
    path: "/invoices/{id}/void",
    scope: "post",
    destructive: true,
    input: Void,
    run: (ctx, input) => invoices.voidInvoice(ctx, input),
  }),
  op({
    name: "delete_invoice",
    title: "Delete a draft invoice",
    description: "Discard a draft invoice. Posted invoices must be voided instead.",
    group: "Sales",
    method: "DELETE",
    path: "/invoices/{id}",
    scope: "write",
    destructive: true,
    input: ById,
    run: (ctx, input) => invoices.deleteDraftInvoice(ctx, input),
  }),
  op({
    name: "list_customer_payments",
    title: "List payments received",
    description: "Customer payments, newest first. Filter by status or customerId.",
    group: "Sales",
    method: "GET",
    path: "/customer-payments",
    scope: "read",
    input: customerPayments.ListCustomerPaymentsSchema,
    run: (ctx, input) => customerPayments.listCustomerPayments(ctx, input),
  }),
  op({
    name: "get_customer_payment",
    title: "Get a payment received",
    description: "One customer payment and the invoices it was applied to.",
    group: "Sales",
    method: "GET",
    path: "/customer-payments/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => customerPayments.getCustomerPayment(ctx, input),
  }),
  op({
    name: "create_customer_payment",
    title: "Receive a customer payment",
    description: `Record money received from a customer. Either list applications [{ invoiceId, amount, discountAmount? }] or just give the total amount and it is applied to their open invoices oldest-due first. Lands in 1250 Undeposited Funds unless depositAccountId is given. Overpayments aren't supported yet. ${POSTING_NOTE}`,
    group: "Sales",
    method: "POST",
    path: "/customer-payments",
    scope: "write",
    input: customerPayments.CreateCustomerPaymentSchema,
    run: (ctx, input) => customerPayments.createCustomerPayment(ctx, input),
  }),
  op({
    name: "post_customer_payment",
    title: "Post a draft customer payment",
    description: "Post a draft payment: Dr deposit account / Cr AR, and mark paid invoices paid.",
    group: "Sales",
    method: "POST",
    path: "/customer-payments/{id}/post",
    scope: "post",
    input: ById,
    run: (ctx, input) => customerPayments.postCustomerPayment(ctx, input),
  }),
  op({
    name: "void_customer_payment",
    title: "Void a customer payment",
    description: "Void a posted payment (e.g. a bounced check): reverses it and reopens its invoices. Requires admin.",
    group: "Sales",
    method: "POST",
    path: "/customer-payments/{id}/void",
    scope: "post",
    destructive: true,
    input: Void,
    run: (ctx, input) => customerPayments.voidCustomerPayment(ctx, input),
  }),
  op({
    name: "delete_customer_payment",
    title: "Delete a draft customer payment",
    description: "Discard a draft customer payment.",
    group: "Sales",
    method: "DELETE",
    path: "/customer-payments/{id}",
    scope: "write",
    destructive: true,
    input: ById,
    run: (ctx, input) => customerPayments.deleteDraftCustomerPayment(ctx, input),
  }),

  // --------------------------------------------------------------- Expenses
  op({
    name: "list_vendors",
    title: "List / search vendors",
    description: "Vendors with their open AP balance. Search with q before creating one.",
    group: "Expenses",
    method: "GET",
    path: "/vendors",
    scope: "read",
    input: parties.ListPartiesSchema,
    run: (ctx, input) => parties.listVendors(ctx, input),
  }),
  op({
    name: "get_vendor",
    title: "Get a vendor",
    description: "One vendor, including open balance, terms, and 1099 status.",
    group: "Expenses",
    method: "GET",
    path: "/vendors/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => parties.getVendor(ctx, input),
  }),
  op({
    name: "create_vendor",
    title: "Create a vendor",
    description: "Add a vendor. Only name is required. Set is1099Vendor for contractors who get a 1099.",
    group: "Expenses",
    method: "POST",
    path: "/vendors",
    scope: "write",
    input: parties.CreateVendorSchema,
    run: (ctx, input) => parties.createVendor(ctx, input),
  }),
  op({
    name: "update_vendor",
    title: "Update a vendor",
    description: "Change fields on a vendor. Only the fields you send change.",
    group: "Expenses",
    method: "PATCH",
    path: "/vendors/{id}",
    scope: "write",
    input: parties.UpdateVendorSchema,
    run: (ctx, input) => parties.updateVendor(ctx, input),
  }),
  op({
    name: "list_bills",
    title: "List bills",
    description:
      "Vendor bills with vendor name and open balance. Filter by status, vendorId, unpaidOnly, or q (bill #, vendor invoice #, vendor name).",
    group: "Expenses",
    method: "GET",
    path: "/bills",
    scope: "read",
    input: bills.ListBillsSchema,
    run: (ctx, input) => bills.listBills(ctx, input),
  }),
  op({
    name: "get_bill",
    title: "Get a bill",
    description: "One bill with lines and open balance.",
    group: "Expenses",
    method: "GET",
    path: "/bills/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => bills.getBill(ctx, input),
  }),
  op({
    name: "create_bill",
    title: "Enter a bill",
    description:
      "Enter a vendor bill: lines of { accountId (expense/asset/COGS), amount, description }. Include the vendor's invoice number; the same number for the same vendor is rejected as a duplicate. Bills go draft → submitted for approval → approved → posted. Pass submit=true to submit in the same call.",
    group: "Expenses",
    method: "POST",
    path: "/bills",
    scope: "write",
    input: bills.CreateBillSchema,
    run: (ctx, input) => bills.createBill(ctx, input),
  }),
  op({
    name: "update_bill",
    title: "Update a draft or rejected bill",
    description: "Replace a draft or rejected bill's header and lines. Saving a rejected bill puts it back to draft.",
    group: "Expenses",
    method: "PATCH",
    path: "/bills/{id}",
    scope: "write",
    input: bills.UpdateBillSchema,
    run: (ctx, input) => bills.updateBill(ctx, input),
  }),
  op({
    name: "submit_bill",
    title: "Submit a bill for approval",
    description: "Move a draft bill to pending_approval. Approval thresholds decide which role must approve it.",
    group: "Expenses",
    method: "POST",
    path: "/bills/{id}/submit",
    scope: "write",
    input: ById,
    run: (ctx, input) => bills.submitBill(ctx, input),
  }),
  op({
    name: "approve_bill",
    title: "Approve a bill",
    description:
      "Approve a pending bill. Your role must meet the approval threshold for its amount, and an agent can never approve a bill it created.",
    group: "Expenses",
    method: "POST",
    path: "/bills/{id}/approve",
    scope: "post",
    input: ById,
    run: (ctx, input) => bills.approveBill(ctx, input),
  }),
  op({
    name: "reject_bill",
    title: "Reject a bill",
    description: "Send a pending bill back with a reason. The submitter can edit and resubmit it.",
    group: "Expenses",
    method: "POST",
    path: "/bills/{id}/reject",
    scope: "post",
    input: Void,
    run: (ctx, input) => bills.rejectBill(ctx, input),
  }),
  op({
    name: "post_bill",
    title: "Post an approved bill",
    description: "Post an approved bill to the ledger: Dr each line's account / Cr Accounts Payable. Requires the accountant role.",
    group: "Expenses",
    method: "POST",
    path: "/bills/{id}/post",
    scope: "post",
    input: ById,
    run: (ctx, input) => bills.postBill(ctx, input),
  }),
  op({
    name: "void_bill",
    title: "Void a bill",
    description: "Void a posted bill with no payments: posts a reversal. Requires admin.",
    group: "Expenses",
    method: "POST",
    path: "/bills/{id}/void",
    scope: "post",
    destructive: true,
    input: Void,
    run: (ctx, input) => bills.voidBill(ctx, input),
  }),
  op({
    name: "list_bill_payments",
    title: "List bill payments",
    description: "Payments to vendors, newest first. Filter by status or vendorId.",
    group: "Expenses",
    method: "GET",
    path: "/bill-payments",
    scope: "read",
    input: billPayments.ListBillPaymentsSchema,
    run: (ctx, input) => billPayments.listBillPayments(ctx, input),
  }),
  op({
    name: "get_bill_payment",
    title: "Get a bill payment",
    description: "One bill payment and the bills it paid.",
    group: "Expenses",
    method: "GET",
    path: "/bill-payments/{id}",
    scope: "read",
    input: ById,
    run: (ctx, input) => billPayments.getBillPayment(ctx, input),
  }),
  op({
    name: "create_bill_payment",
    title: "Pay bills",
    description: `Record a payment to a vendor against posted bills: applications [{ billId, amount, discountAmount? }] where amount is cash and the discount is on top. bankAccountId must be a bank / cash account. ${POSTING_NOTE}`,
    group: "Expenses",
    method: "POST",
    path: "/bill-payments",
    scope: "write",
    input: billPayments.CreateBillPaymentSchema,
    run: (ctx, input) => billPayments.createBillPayment(ctx, input),
  }),
  op({
    name: "post_bill_payment",
    title: "Post a draft bill payment",
    description: "Post a draft bill payment: Dr AP / Cr bank (and Cr 4940 for discounts). Requires the accountant role.",
    group: "Expenses",
    method: "POST",
    path: "/bill-payments/{id}/post",
    scope: "post",
    input: ById,
    run: (ctx, input) => billPayments.postBillPayment(ctx, input),
  }),
  op({
    name: "void_bill_payment",
    title: "Void a bill payment",
    description: "Void a posted bill payment: reverses it and reopens the bills. Requires admin.",
    group: "Expenses",
    method: "POST",
    path: "/bill-payments/{id}/void",
    scope: "post",
    destructive: true,
    input: Void,
    run: (ctx, input) => billPayments.voidBillPayment(ctx, input),
  }),
  op({
    name: "delete_bill_payment",
    title: "Delete a draft bill payment",
    description: "Discard a draft bill payment.",
    group: "Expenses",
    method: "DELETE",
    path: "/bill-payments/{id}",
    scope: "write",
    destructive: true,
    input: ById,
    run: (ctx, input) => billPayments.deleteDraftBillPayment(ctx, input),
  }),

  // ---------------------------------------------------------------- Reports
  op({
    name: "report_profit_and_loss",
    title: "Profit and loss",
    description: "Income statement for a date range (default: year to date): revenue, COGS, gross profit, expenses, net income.",
    group: "Reports",
    method: "GET",
    path: "/reports/profit-and-loss",
    scope: "read",
    input: financial.RangeSchema,
    run: (ctx, input) => financial.profitAndLoss(ctx, input),
  }),
  op({
    name: "report_balance_sheet",
    title: "Balance sheet",
    description: "Assets, liabilities, and equity as of a date (default today), including current-year earnings.",
    group: "Reports",
    method: "GET",
    path: "/reports/balance-sheet",
    scope: "read",
    input: financial.AsOfSchema,
    run: (ctx, input) => financial.balanceSheet(ctx, input),
  }),
  op({
    name: "report_trial_balance",
    title: "Trial balance",
    description: "Debit and credit totals per account as of a date. Total debits always equal total credits.",
    group: "Reports",
    method: "GET",
    path: "/reports/trial-balance",
    scope: "read",
    input: financial.TrialBalanceSchema,
    run: (ctx, input) => financial.trialBalance(ctx, input),
  }),
  op({
    name: "report_account_ledger",
    title: "Account ledger (GL detail)",
    description: "Every posting to one account in a date range with a running balance. Use to explain a balance.",
    group: "Reports",
    method: "GET",
    path: "/reports/account-ledger",
    scope: "read",
    input: financial.AccountLedgerSchema,
    run: (ctx, input) => financial.accountLedger(ctx, input),
  }),
  op({
    name: "report_ar_aging",
    title: "AR aging",
    description: "Who owes the business money and how late: open invoice balances per customer in current / 1–30 / 31–60 / 61–90 / 90+ day buckets.",
    group: "Reports",
    method: "GET",
    path: "/reports/ar-aging",
    scope: "read",
    input: AgingSchema,
    run: (ctx, input) => arAging(ctx, input),
  }),
  op({
    name: "report_ap_aging",
    title: "AP aging",
    description: "What the business owes vendors and how late: open bill balances per vendor by age bucket.",
    group: "Reports",
    method: "GET",
    path: "/reports/ap-aging",
    scope: "read",
    input: AgingSchema,
    run: (ctx, input) => apAging(ctx, input),
  }),

  // ----------------------------------------------------------------- Review
  op({
    name: "list_review_queue",
    title: "Review queue",
    description:
      "Everything waiting on a human: drafts created by agents and bills pending approval. Use it to tell the user what needs their attention, or to check whether your own drafts were posted.",
    group: "Review",
    method: "GET",
    path: "/review-queue",
    scope: "read",
    input: Empty,
    run: (ctx) => listReviewQueue(ctx),
  }),
  op({
    name: "list_activity",
    title: "Activity log",
    description:
      "The audit trail: who (person or agent) did what, through which channel, newest first. Filter by agentId, agentsOnly, entityId (one document's history), or since.",
    group: "Review",
    method: "GET",
    path: "/activity",
    scope: "read",
    input: ListActivitySchema,
    run: (ctx, input) => listActivity(ctx, input),
  }),
];

export const OPERATIONS_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

/** Match "METHOD /a/b/c" against the registry; returns the op + path params. */
export function matchOperation(
  method: string,
  pathSegments: string[]
): { op: Operation; params: Record<string, string> } | null {
  for (const op of OPERATIONS) {
    if (op.method !== method) continue;
    const tmpl = op.path.split("/").filter(Boolean);
    if (tmpl.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < tmpl.length; i++) {
      const t = tmpl[i];
      if (t.startsWith("{") && t.endsWith("}")) params[t.slice(1, -1)] = decodeURIComponent(pathSegments[i]);
      else if (t !== pathSegments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { op, params };
  }
  return null;
}

/** True for operations that change state (idempotency + dry-run apply). */
export function isMutation(op: Operation): boolean {
  return op.method !== "GET";
}
