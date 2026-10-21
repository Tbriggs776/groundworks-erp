/**
 * A fake QuickBooks Online for the import tests: Intuit's consent page
 * (which says yes at once), its token endpoint (authorization code,
 * refresh with rotation, revoke), and the accounting API's companyinfo,
 * preferences, and query (paging and count(*)), on a local port. Knobs on `state` make it throttle, fail, expire the
 * access token, or hide a record from the first scan, the way the real
 * service does now and then.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_CLIENT_ID = "fake-client";
export const FAKE_CLIENT_SECRET = "fake-secret";
export const GOOD_CODE = "good-code";

type Rec = Record<string, unknown> & { Id: string };

export type FakeQbo = {
  url: string;
  state: {
    realmId: string;
    accessToken: string;
    refreshToken: string;
    refreshes: number;
    revoked: string[];
    /** Answer the next N API calls with 429. */
    throttle: number;
    /** Answer every query on this entity with 500 until cleared. */
    failEntity: string | null;
    /** Leave this record out of the first listing of its entity (as if made between pages). */
    hideOnce: { entity: string; id: string } | null;
    queries: string[];
  };
  data: Record<string, Rec[]>;
  /** The access token stops working (as when it expires early): the next call gets 401. */
  expireAccess: () => void;
  close: () => Promise<void>;
};

const ref = (value: string, name?: string) => ({ value, ...(name ? { name } : {}) });

function fixtures(): Record<string, Rec[]> {
  const acct = (Id: string, Name: string, AccountType: string, extra: Record<string, unknown> = {}): Rec => ({
    Id,
    Name,
    FullyQualifiedName: Name,
    AccountType,
    Active: true,
    ...extra,
  });
  const line = (side: "Debit" | "Credit", amount: number, account: string, extra: Record<string, unknown> = {}) => ({
    DetailType: "JournalEntryLineDetail",
    Amount: amount,
    JournalEntryLineDetail: { PostingType: side, AccountRef: ref(account), ...extra },
  });
  return {
    Account: [
      acct("1", "Checking", "Bank", { AcctNum: "1010", AccountSubType: "Checking" }),
      acct("2", "Accounts Receivable (A/R)", "Accounts Receivable", { AcctNum: "1100", AccountSubType: "AccountsReceivable" }),
      acct("3", "Accounts Payable (A/P)", "Accounts Payable", { AccountSubType: "AccountsPayable" }),
      acct("4", "Undeposited Funds", "Other Current Asset", { AccountSubType: "UndepositedFunds" }),
      acct("5", "Inventory Asset", "Other Current Asset", { AccountSubType: "Inventory" }),
      acct("6", "Opening Balance Equity", "Equity", { AccountSubType: "OpeningBalanceEquity" }),
      acct("7", "Retained Earnings", "Equity", { AccountSubType: "RetainedEarnings" }),
      acct("8", "Sales of Product Income", "Income", { AcctNum: "4000", AccountSubType: "SalesOfProductIncome" }),
      acct("9", "Services", "Income", { AcctNum: "4930", AccountSubType: "ServiceFeeIncome" }),
      acct("10", "Installation", "Income", { FullyQualifiedName: "Services:Installation", SubAccount: true, ParentRef: ref("9") }),
      acct("11", "Cost of Goods Sold", "Cost of Goods Sold", { AcctNum: "5050", AccountSubType: "SuppliesMaterialsCogs" }),
      acct("12", "Rent Expense", "Expense", { AccountSubType: "RentOrLeaseOfBuildings" }),
      acct("13", "Old Expense", "Expense", { Active: false }),
      acct("14", "Board of Equalization Payable", "Other Current Liability", { AccountSubType: "GlobalTaxPayable" }),
      acct("15", "Visa", "Credit Card", { AccountSubType: "CreditCard" }),
      acct("16", "Accumulated Depreciation", "Fixed Asset", { AccountSubType: "AccumulatedDepreciation" }),
      acct("17", "Savings", "Bank", { AcctNum: "1020", AccountSubType: "Savings" }),
      acct("18", "Discounts given", "Income", { AccountSubType: "DiscountsRefundsGiven" }),
      acct("19", "Office Supplies", "Expense", { AccountSubType: "SuppliesMaterials" }),
    ],
    Term: [
      { Id: "1", Name: "Net 30", DueDays: 30, Active: true },
      { Id: "2", Name: "Net 15", DueDays: 15, Active: true },
      { Id: "3", Name: "Due on the 10th", DayOfMonthDue: 10, Active: true },
      // Enough more for full pages wherever a batch resumes.
      ...Array.from({ length: 1997 }, (_, i) => ({ Id: String(100 + i), Name: `Net ${i + 31} (${i})`, DueDays: (i % 300) + 1, Active: i % 2 === 0 })),
    ],
    Class: [
      { Id: "1", Name: "Residential", FullyQualifiedName: "Residential", Active: true },
      { Id: "2", Name: "Commercial", FullyQualifiedName: "Commercial", Active: true },
      { Id: "3", Name: "Retail", FullyQualifiedName: "Commercial:Retail", SubClass: true, ParentRef: ref("2"), Active: true },
      { Id: "4", Name: "Old", FullyQualifiedName: "Old", Active: false },
    ],
    Department: [
      { Id: "1", Name: "North", FullyQualifiedName: "North", Active: true },
      { Id: "2", Name: "South", FullyQualifiedName: "South", Active: true },
    ],
    Customer: [
      {
        Id: "1",
        DisplayName: "Amy's Bird Sanctuary",
        PrimaryEmailAddr: { Address: "Birds@Intuit.com" },
        PrimaryPhone: { FreeFormNumber: "(650) 555-3311" },
        SalesTermRef: ref("1"),
        BillAddr: { Line1: "4581 Finch St.", City: "Bayshore", CountrySubDivisionCode: "CA", PostalCode: "94326" },
        Active: true,
      },
      { Id: "2", DisplayName: "Bill's Windsurf Shop", PrimaryEmailAddr: { Address: "not an email, Surf@Intuit.com" }, SalesTermRef: ref("3"), Active: true },
      { Id: "3", DisplayName: "Cool Cars", Active: false },
      { Id: "4", DisplayName: "Bad Email Co", PrimaryEmailAddr: { Address: "nope" }, Taxable: false, Active: true },
      { Id: "5", DisplayName: "Euro Customer", CurrencyRef: ref("EURO"), Active: true },
    ],
    Vendor: [
      { Id: "1", DisplayName: "Books by Bessie", Vendor1099: true, TermRef: ref("2"), PrimaryEmailAddr: { Address: "Books@Intuit.com" }, Active: true },
      { Id: "2", DisplayName: "Hicks Hardware", BillAddr: { Line1: "42 Main St", City: "Middlefield", PostalCode: "94303" }, Active: true },
      { Id: "3", DisplayName: "Inactive Vendor", Active: false },
    ],
    Item: [
      { Id: "1", Name: "Design", Type: "Service", IncomeAccountRef: ref("9"), UnitPrice: 75, Taxable: false, Active: true },
      {
        Id: "2",
        Name: "Rock Fountain",
        Sku: "RF-1",
        Type: "Inventory",
        IncomeAccountRef: ref("8"),
        ExpenseAccountRef: ref("11"),
        AssetAccountRef: ref("5"),
        UnitPrice: 275,
        PurchaseCost: 125,
        Taxable: true,
        Active: true,
      },
      { Id: "3", Name: "Pump", Type: "NonInventory", UnitPrice: 15, Active: true },
      { Id: "4", Name: "Garden Kit", Type: "Group", Active: true },
      { Id: "5", Name: "Landscaping", Type: "Category", Active: true },
      { Id: "6", Name: "Sprinkler Heads", FullyQualifiedName: "Sprinklers:Sprinkler Heads", SubItem: true, Type: "Service", IncomeAccountRef: ref("10"), Active: true },
    ],
    JournalEntry: [
      { Id: "1", DocNumber: "JE-1", TxnDate: "2026-01-15", PrivateNote: "Opening cash", Line: [line("Debit", 1000, "1"), line("Credit", 1000, "6")] },
      {
        Id: "2",
        TxnDate: "2025-07-20",
        Line: [line("Debit", 500, "12", { ClassRef: ref("1"), DepartmentRef: ref("1") }), line("Credit", 500, "1")],
      },
      {
        Id: "3",
        DocNumber: "ADJ-1",
        TxnDate: "2026-02-01",
        Adjustment: true,
        Line: [line("Debit", 250, "2", { Entity: { Type: "Customer", EntityRef: ref("1") } }), line("Credit", 250, "9")],
      },
      {
        Id: "4",
        TxnDate: "2026-02-05",
        Line: [line("Debit", 100, "3", { Entity: { Type: "Vendor", EntityRef: ref("1") } }), line("Credit", 100, "1")],
      },
      { Id: "5", DocNumber: "JE-5", TxnDate: "2026-02-10", Line: [line("Debit", 20, "999"), line("Credit", 20, "1")] },
      { Id: "6", DocNumber: "JE-6", TxnDate: "2026-02-11", Line: [line("Debit", 100, "12"), line("Credit", 90, "1")] },
      { Id: "7", DocNumber: "JE-7", TxnDate: "2026-02-12", Line: [{ DetailType: "DescriptionOnly", Description: "memo only" }] },
      { Id: "8", DocNumber: "JE-8", TxnDate: "2026-08-01", Line: [line("Debit", 40, "12"), line("Credit", 40, "15")] },
    ],
    ...history(),
  };
}

/**
 * Part 2's history: sales tax, sales, purchases, what paid them, and
 * deposits. The test works out every balance from these by hand.
 */
function history(): Record<string, Rec[]> {
  const sale = (item: string, qty: number, price: number, extra: Record<string, unknown> = {}) => ({
    DetailType: "SalesItemLineDetail",
    Amount: Math.round(qty * price * 100) / 100,
    SalesItemLineDetail: { ItemRef: ref(item), Qty: qty, UnitPrice: price, TaxCodeRef: ref("NON"), ...extra },
  });
  const taxed = (item: string, qty: number, price: number, extra: Record<string, unknown> = {}) => sale(item, qty, price, { TaxCodeRef: ref("TAX"), ...extra });
  const tax = (code: string, lines: Array<[string, number, number, number]>) => ({
    TxnTaxCodeRef: ref(code),
    TotalTax: Math.round(lines.reduce((a, l) => a + l[3], 0) * 100) / 100,
    TaxLine: lines.map(([rate, percent, taxable, amount]) => ({
      Amount: amount,
      DetailType: "TaxLineDetail",
      TaxLineDetail: { TaxRateRef: ref(rate), PercentBased: true, TaxPercent: percent, NetAmountTaxable: taxable },
    })),
  });
  const exp = (account: string, amount: number, extra: Record<string, unknown> = {}) => ({
    DetailType: "AccountBasedExpenseLineDetail",
    Amount: amount,
    AccountBasedExpenseLineDetail: { AccountRef: ref(account), ...extra },
  });
  const bought = (item: string, qty: number, cost: number, extra: Record<string, unknown> = {}) => ({
    DetailType: "ItemBasedExpenseLineDetail",
    Amount: qty * cost,
    ItemBasedExpenseLineDetail: { ItemRef: ref(item), Qty: qty, UnitPrice: cost, ...extra },
  });
  const linked = (type: string, id: string, amount: number) => ({ Amount: amount, LinkedTxn: [{ TxnId: id, TxnType: type }] });
  const voided = { TotalAmt: 0, PrivateNote: "Voided", MetaData: { LastUpdatedTime: "2026-04-02T10:00:00-07:00" } };
  return {
    TaxAgency: [
      { Id: "1", DisplayName: "Board of Equalization" },
      { Id: "2", DisplayName: "City of Tucson" },
    ],
    TaxRate: [
      { Id: "1", Name: "California", RateValue: 8, AgencyRef: ref("1"), Active: true },
      { Id: "2", Name: "Tucson City", RateValue: 2, AgencyRef: ref("2"), Active: true },
      { Id: "3", Name: "Old Rate", RateValue: 5, AgencyRef: ref("1"), Active: false },
    ],
    TaxCode: [
      { Id: "TAX", Name: "TAX", Active: true, Taxable: true, SalesTaxRateList: { TaxRateDetail: [] } },
      { Id: "NON", Name: "NON", Active: true, Taxable: false, SalesTaxRateList: { TaxRateDetail: [] } },
      { Id: "1", Name: "California", Active: true, Taxable: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: ref("1") }] } },
      { Id: "2", Name: "CA + Tucson", Active: true, Taxable: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: ref("1") }, { TaxRateRef: ref("2") }] } },
    ],
    PaymentMethod: [
      { Id: "1", Name: "Cash", Type: "NON_CREDIT_CARD", Active: true },
      { Id: "2", Name: "Check", Type: "NON_CREDIT_CARD", Active: true },
      { Id: "3", Name: "Visa", Type: "CREDIT_CARD", Active: true },
    ],
    Invoice: [
      {
        Id: "101",
        DocNumber: "1001",
        TxnDate: "2026-03-01",
        DueDate: "2026-03-31",
        CustomerRef: ref("1", "Amy's Bird Sanctuary"),
        DepartmentRef: ref("1"),
        CustomerMemo: { value: "Thank you for your business." },
        Line: [
          sale("1", 2, 75, { ClassRef: ref("1") }),
          taxed("2", 1, 275, { ClassRef: ref("2") }),
          { DetailType: "DiscountLineDetail", Amount: 10, DiscountLineDetail: { PercentBased: false, DiscountAccountRef: ref("18") } },
          { DetailType: "SubTotalLineDetail", Amount: 415, SubTotalLineDetail: {} },
        ],
        TxnTaxDetail: tax("1", [["1", 8, 275, 22]]),
        TotalAmt: 437,
      },
      {
        Id: "102",
        DocNumber: "1002",
        TxnDate: "2026-03-05",
        CustomerRef: ref("2", "Bill's Windsurf Shop"),
        Line: [
          taxed("3", 4, 15),
          { DetailType: "GroupLineDetail", Amount: 75, GroupLineDetail: { GroupItemRef: ref("4"), Quantity: 1, Line: [sale("1", 1, 75)] } },
          { DetailType: "SalesItemLineDetail", Amount: 10, SalesItemLineDetail: { ItemRef: ref("SHIPPING_ITEM_ID"), TaxCodeRef: ref("NON") } },
        ],
        TxnTaxDetail: tax("2", [
          ["1", 8, 60, 4.8],
          ["2", 2, 60, 1.2],
        ]),
        TotalAmt: 151,
      },
      { Id: "103", DocNumber: "1003", TxnDate: "2026-03-07", CustomerRef: ref("1"), Line: [{ ...sale("1", 1, 0), Amount: 0 }], ...voided },
      { Id: "104", DocNumber: "1004", TxnDate: "2026-04-01", CustomerRef: ref("4", "Bad Email Co"), Line: [sale("1", 2, 75)], TotalAmt: 150 },
      { Id: "106", DocNumber: "1006", TxnDate: "2026-04-02", CustomerRef: ref("5", "Euro Customer"), Line: [sale("1", 1, 75)], TotalAmt: 75 },
    ],
    CreditMemo: [
      { Id: "201", DocNumber: "5001", TxnDate: "2026-03-15", CustomerRef: ref("1"), Line: [{ ...sale("1", 1, 50) }], TotalAmt: 50 },
      { Id: "202", DocNumber: "5001", TxnDate: "2026-03-20", CustomerRef: ref("2"), Line: [{ ...sale("1", 1, 25) }], TotalAmt: 25 },
    ],
    SalesReceipt: [
      {
        Id: "301",
        DocNumber: "7001",
        TxnDate: "2026-03-03",
        PaymentMethodRef: ref("1"),
        DepositToAccountRef: ref("4"),
        Line: [taxed("3", 2, 15)],
        TxnTaxDetail: tax("1", [["1", 8, 30, 2.4]]),
        TotalAmt: 32.4,
      },
      {
        Id: "302",
        DocNumber: "7002",
        TxnDate: "2026-03-04",
        CustomerRef: ref("1"),
        PaymentMethodRef: ref("3"),
        DepositToAccountRef: ref("1"),
        Line: [sale("1", 1, 75)],
        TotalAmt: 75,
      },
    ],
    RefundReceipt: [
      {
        Id: "401",
        DocNumber: "8001",
        TxnDate: "2026-03-25",
        CustomerRef: ref("2"),
        PaymentMethodRef: ref("2"),
        PaymentRefNum: "1049",
        DepositToAccountRef: ref("1"),
        Line: [taxed("3", 1, 15)],
        TxnTaxDetail: tax("1", [["1", 8, 15, 1.2]]),
        TotalAmt: 16.2,
      },
    ],
    Payment: [
      {
        Id: "501",
        TxnDate: "2026-03-20",
        CustomerRef: ref("1"),
        TotalAmt: 387,
        PaymentMethodRef: ref("2"),
        PaymentRefNum: "4521",
        DepositToAccountRef: ref("4"),
        Line: [linked("Invoice", "101", 437), linked("CreditMemo", "201", 50)],
      },
      { Id: "502", TxnDate: "2026-03-22", CustomerRef: ref("2"), TotalAmt: 200, DepositToAccountRef: ref("4"), Line: [linked("Invoice", "102", 151)] },
      { Id: "503", TxnDate: "2026-04-05", CustomerRef: ref("4"), TotalAmt: 100, DepositToAccountRef: ref("1"), Line: [linked("Invoice", "104", 100)] },
      { Id: "504", TxnDate: "2026-04-06", CustomerRef: ref("4"), Line: [], ...voided },
    ],
    Deposit: [
      {
        Id: "601",
        TxnDate: "2026-03-23",
        DepositToAccountRef: ref("1"),
        Line: [
          linked("Payment", "501", 387),
          linked("SalesReceipt", "301", 32.4),
          {
            Amount: 100,
            DetailType: "DepositLineDetail",
            DepositLineDetail: { AccountRef: ref("9"), Entity: { value: "1", type: "Customer" }, ClassRef: ref("1") },
          },
        ],
        CashBack: { AccountRef: ref("19"), Amount: 20, Memo: "Petty cash" },
        TotalAmt: 499.4,
      },
    ],
    Bill: [
      {
        Id: "701",
        DocNumber: "H-100",
        TxnDate: "2026-02-15",
        DueDate: "2026-03-15",
        VendorRef: ref("2", "Hicks Hardware"),
        DepartmentRef: ref("2"),
        Line: [bought("2", 3, 125, { ClassRef: ref("2") }), exp("12", 1000, { ClassRef: ref("1") })],
        TotalAmt: 1375,
      },
      { Id: "702", DocNumber: "B-7", TxnDate: "2026-02-20", VendorRef: ref("1"), Line: [exp("13", 200)], TotalAmt: 200 },
      { Id: "703", DocNumber: "H-101", TxnDate: "2026-03-01", VendorRef: ref("2"), Line: [exp("19", 300), exp("19", -50), exp("19", 0)], TotalAmt: 250 },
    ],
    VendorCredit: [{ Id: "801", DocNumber: "HC-1", TxnDate: "2026-03-05", VendorRef: ref("2"), Line: [exp("19", 40)], TotalAmt: 40 }],
    BillPayment: [
      {
        Id: "901",
        DocNumber: "1050",
        TxnDate: "2026-03-10",
        VendorRef: ref("2"),
        PayType: "Check",
        CheckPayment: { BankAccountRef: ref("1") },
        TotalAmt: 1335,
        Line: [linked("Bill", "701", 1375), linked("VendorCredit", "801", 40)],
      },
      {
        Id: "902",
        TxnDate: "2026-03-12",
        VendorRef: ref("1"),
        PayType: "CreditCard",
        CreditCardPayment: { CCAccountRef: ref("15") },
        TotalAmt: 250,
        Line: [linked("Bill", "702", 200)],
      },
      { Id: "903", DocNumber: "1051", TxnDate: "2026-03-13", VendorRef: ref("2"), PayType: "Check", CheckPayment: { BankAccountRef: ref("1") }, Line: [], ...voided },
    ],
    Purchase: [
      {
        Id: "1001",
        PaymentType: "Check",
        DocNumber: "1052",
        TxnDate: "2026-03-02",
        AccountRef: ref("1"),
        EntityRef: { value: "1", name: "Books by Bessie", type: "Vendor" },
        Line: [exp("12", 500, { ClassRef: ref("1") })],
        TotalAmt: 500,
      },
      {
        Id: "1002",
        PaymentType: "CreditCard",
        TxnDate: "2026-03-06",
        AccountRef: ref("15"),
        EntityRef: { value: "2", type: "Vendor" },
        Line: [bought("2", 2, 120)],
        TotalAmt: 240,
      },
      {
        Id: "1003",
        PaymentType: "CreditCard",
        Credit: true,
        TxnDate: "2026-03-08",
        AccountRef: ref("15"),
        EntityRef: { value: "2", type: "Vendor" },
        Line: [exp("19", 30)],
        TotalAmt: 30,
      },
      {
        Id: "1004",
        PaymentType: "Cash",
        TxnDate: "2026-03-09",
        AccountRef: ref("1"),
        PaymentMethodRef: ref("1"),
        EntityRef: { value: "55", name: "Pat Smith", type: "Employee" },
        Line: [exp("19", 45)],
        TotalAmt: 45,
      },
      { Id: "1005", PaymentType: "Check", DocNumber: "1053", TxnDate: "2026-03-11", AccountRef: ref("1"), Line: [exp("19", 0)], ...voided },
    ],
    Transfer: [
      { Id: "1101", TxnDate: "2026-03-15", FromAccountRef: ref("1"), ToAccountRef: ref("17"), Amount: 300 },
      { Id: "1102", TxnDate: "2026-03-28", FromAccountRef: ref("1"), ToAccountRef: ref("15"), Amount: 200, PrivateNote: "Paying the Visa" },
    ],
  };
}

/** What QuickBooks' transaction list says is cleared or reconciled, per account. */
export const CLEARED: Record<string, Record<"Reconciled" | "Cleared", Array<[string, string]>>> = {
  "1": {
    Reconciled: [
      ["Journal Entry", "1"],
      ["Check", "1001"],
      ["Deposit", "601"],
      ["Transfer", "1101"],
      ["Check", "9999"],
    ],
    Cleared: [
      ["Bill Payment (Check)", "901"],
      ["Cash Expense", "1004"],
    ],
  },
  "15": {
    Reconciled: [["Credit Card Expense", "1002"]],
    Cleared: [
      ["Credit Card Credit", "1003"],
      ["Transfer", "1102"],
    ],
  },
};

function transactionList(account: string, cleared: string) {
  const rows = CLEARED[account]?.[cleared as "Reconciled" | "Cleared"] ?? [];
  return {
    Header: { ReportName: "TransactionList" },
    Columns: {
      Column: [
        { ColTitle: "Date", ColType: "Date", MetaData: [{ Name: "ColKey", Value: "tx_date" }] },
        { ColTitle: "Transaction Type", ColType: "String", MetaData: [{ Name: "ColKey", Value: "txn_type" }] },
        { ColTitle: "Num", ColType: "String", MetaData: [{ Name: "ColKey", Value: "doc_num" }] },
      ],
    },
    Rows: { Row: rows.map(([type, id]) => ({ type: "Data", ColData: [{ value: "2026-03-01" }, { value: type, id }, { value: "" }] })) },
  };
}

const COMPANY = (realmId: string, name: string) => ({
  CompanyInfo: {
    Id: realmId,
    CompanyName: name,
    LegalName: `${name} LLC`,
    CompanyAddr: { Line1: "123 Sierra Way", City: "San Pablo", CountrySubDivisionCode: "CA", PostalCode: "87999" },
    PrimaryPhone: { FreeFormNumber: "4081234567" },
    Email: { Address: "noreply@quickbooks.com" },
    WebAddr: { URI: "https://example.com" },
  },
});

const PREFERENCES = {
  Preferences: {
    AccountingInfoPrefs: { FirstMonthOfFiscalYear: "July" },
    CurrencyPrefs: { HomeCurrency: ref("USD"), MultiCurrencyEnabled: false },
  },
};

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(json));
}

const fault = (message: string, detail: string) => ({ Fault: { Error: [{ Message: message, Detail: detail }], type: "ValidationFault" } });

export async function startFakeQbo(opts: { realmId: string; companyName: string; port?: number }): Promise<FakeQbo> {
  let n = 0;
  const token = (kind: string) => `${kind}-${++n}-${Math.random().toString(36).slice(2)}`;
  const data = fixtures();
  const hidden = new Set<string>();
  const state: FakeQbo["state"] = {
    realmId: opts.realmId,
    accessToken: "",
    refreshToken: "",
    refreshes: 0,
    revoked: [],
    throttle: 0,
    failEntity: null,
    hideOnce: null,
    queries: [],
  };
  const issue = () => {
    state.accessToken = token("at");
    state.refreshToken = token("rt");
    return { token_type: "bearer", access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 3600, x_refresh_token_expires_in: 8_726_400 };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const basic = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString("base64")}`;

    if (req.method === "POST" && url.pathname === "/oauth2/v1/tokens/bearer") {
      if (req.headers.authorization !== basic) return send(res, 401, { error: "invalid_client" });
      const form = new URLSearchParams(await body(req));
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== GOOD_CODE) return send(res, 400, { error: "invalid_grant" });
        return send(res, 200, issue());
      }
      if (form.get("grant_type") === "refresh_token") {
        if (!state.refreshToken || form.get("refresh_token") !== state.refreshToken) return send(res, 400, { error: "invalid_grant" });
        state.refreshes += 1;
        return send(res, 200, issue());
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }

    // Intuit's consent page: the person says yes at once.
    if (req.method === "GET" && url.pathname === "/connect/oauth2") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", GOOD_CODE);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("realmId", state.realmId);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/revoke") {
      const { token: t } = JSON.parse((await body(req)) || "{}") as { token?: string };
      if (t) state.revoked.push(t);
      if (t === state.refreshToken) state.refreshToken = state.accessToken = "";
      return send(res, 200, {});
    }

    const m = url.pathname.match(/^\/v3\/company\/([^/]+)\/(.+)$/);
    if (req.method !== "GET" || !m) return send(res, 404, fault("Not found", url.pathname));
    if (req.headers.authorization !== `Bearer ${state.accessToken}` || !state.accessToken) {
      return send(res, 401, { fault: { error: [{ message: "message=AuthenticationFailed", code: "3200" }] } });
    }
    if (m[1] !== state.realmId) return send(res, 403, fault("Forbidden", "Wrong company"));
    if (state.throttle > 0) {
      state.throttle -= 1;
      return send(res, 429, fault("ThrottleExceeded", "Too many requests"), { "retry-after": "0.01" });
    }
    const path = m[2];
    if (path === `companyinfo/${state.realmId}`) return send(res, 200, COMPANY(state.realmId, opts.companyName));
    if (path === "preferences") return send(res, 200, PREFERENCES);
    if (path === "reports/TransactionList") {
      state.queries.push(`report TransactionList ${url.searchParams.get("account")} ${url.searchParams.get("cleared")}`);
      return send(res, 200, transactionList(url.searchParams.get("account") ?? "", url.searchParams.get("cleared") ?? ""));
    }
    if (path !== "query") return send(res, 404, fault("Not found", path));

    const q = (url.searchParams.get("query") ?? "").trim();
    state.queries.push(q);
    const parsed = q.match(/^select (\*|count\(\*\)) from (\w+)(?: where (.+?))?(?: startposition (\d+))?(?: maxresults (\d+))?$/i);
    if (!parsed) return send(res, 400, fault("QueryParserError", `Can't parse: ${q}`));
    const [, what, entity, where, start, max] = parsed;
    if (state.failEntity === entity) return send(res, 500, fault("ServerError", "Something broke"), { "retry-after": "0.01" });
    // An entity the company has none of answers with nothing, as QuickBooks does.
    const all = data[entity] ?? [];
    // Lists answer only active records unless the query asks for both.
    const lists = new Set(["Account", "Term", "Class", "Department", "Customer", "Vendor", "Item", "TaxRate", "TaxCode", "PaymentMethod"]);
    let rows = lists.has(entity) && !/Active in \(true, false\)/i.test(where ?? "") ? all.filter((r) => r.Active !== false) : all;
    if (what.toLowerCase() === "count(*)") return send(res, 200, { QueryResponse: { totalCount: rows.length } });
    const h = state.hideOnce;
    if (h && h.entity === entity && !hidden.has(`${entity}:${h.id}`)) {
      hidden.add(`${entity}:${h.id}`);
      rows = rows.filter((r) => r.Id !== h.id);
    }
    const from = Math.max(1, Number(start ?? 1));
    const page = rows.slice(from - 1, from - 1 + Math.min(1000, Number(max ?? 100)));
    return send(res, 200, { QueryResponse: { [entity]: page, startPosition: from, maxResults: page.length } });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    state,
    data,
    expireAccess: () => {
      state.accessToken = token("at-server-only");
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
