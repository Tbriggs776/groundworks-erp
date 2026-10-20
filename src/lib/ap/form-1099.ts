import Decimal from "decimal.js";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, form1099Box, vendors, type Address } from "@/lib/db/schema";
import { auditFields, requirePermission, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, notFound } from "@/lib/errors";
import { money, toDbMoney } from "@/lib/money";
import { addressLines } from "@/lib/pdf/templates";
import { amount, flag, id } from "@/lib/schemas";

/**
 * 1099 TRACKING. Each expense account can name the 1099 box its vendor
 * payments report in. The yearly report adds up what was paid to each
 * vendor in the calendar year, by payment date:
 *   - bill payments: each payment's cash applied to a bill, spread over the
 *     bill's lines in proportion, counted on lines whose account has a box
 *   - expenses and checks entered in banking with the vendor as payee
 * Card payments are left out (the card company reports them on a 1099-K):
 * anything paid by credit card or from a credit card account. Voided
 * payments don't count. Amounts are in the company's base currency.
 *
 * A vendor is reportable when it's marked as a 1099 vendor and a box
 * reaches its threshold: $600 for tax years through 2025, $2,000 from 2026,
 * and $10 for royalties.
 */

export const FORM_1099_BOXES = form1099Box.enumValues;
export type Form1099Box = (typeof FORM_1099_BOXES)[number];

export const FORM_1099_BOX_LABELS: Record<Form1099Box, string> = {
  nec_1: "1099-NEC box 1, nonemployee compensation",
  misc_1: "1099-MISC box 1, rents",
  misc_2: "1099-MISC box 2, royalties",
  misc_3: "1099-MISC box 3, other income",
  misc_6: "1099-MISC box 6, medical and health care payments",
  misc_10: "1099-MISC box 10, gross proceeds paid to an attorney",
};

/** The general reporting threshold for a tax year. */
export function default1099Threshold(year: number): string {
  return year >= 2026 ? "2000" : "600";
}

/** Royalties report from $10 whatever the general threshold. */
function thresholdFor(box: Form1099Box, general: string): Decimal {
  return box === "misc_2" ? money(10) : money(general);
}

export const Form1099ReportSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional().describe("Calendar (tax) year. Defaults to this year."),
  threshold: amount.optional().describe("General reporting threshold. Defaults to $600 through 2025 and $2,000 from 2026. Royalties always use $10."),
  reportableOnly: flag.optional().describe("Only vendors that get a 1099."),
});

export const Set1099BoxSchema = z.object({
  id: id.describe("The account."),
  box: z.enum(FORM_1099_BOXES).nullable().describe("1099 box its vendor payments report in, or null for none."),
});

export type Form1099Vendor = {
  vendorId: string;
  name: string;
  is1099Vendor: boolean;
  w9OnFile: boolean;
  /** Last 4 of the TIN; the full number appears only in the CSV export. */
  tinLast4: string | null;
  addressLines: string[];
  boxes: Record<Form1099Box, string>;
  total: string;
  /** Marked as a 1099 vendor and a box reaches its threshold. */
  reportable: boolean;
  /** What a filer needs to fix before filing. */
  issues: string[];
};

export type Form1099Report = {
  year: number;
  threshold: string;
  boxLabels: Record<Form1099Box, string>;
  vendors: Form1099Vendor[];
  totals: Record<Form1099Box, string>;
  /** Accounts that report in each box, for reference. */
  mappedAccounts: Array<{ id: string; code: string; name: string; box: Form1099Box }>;
};

type PaidRow = { vendor_id: string; box: Form1099Box; amount: string };

/** Σ paid per vendor and box for the year (base currency, unrounded). */
async function paidByVendorAndBox(ctx: Ctx, year: number): Promise<PaidRow[]> {
  const org = ctx.actor.organizationId;
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  return ctx.tx.execute<PaidRow>(sql`
    SELECT vendor_id, box, SUM(amount)::text AS amount FROM (
      SELECT p.vendor_id, a.form_1099_box AS box,
             pa.applied_amount * bl.amount / NULLIF(b.total_amount, 0) * p.exchange_rate AS amount
        FROM ap_payment_applications pa
        JOIN ap_payments p ON p.id = pa.payment_id
        JOIN accounts bank ON bank.id = p.bank_account_id
        JOIN ap_bills b ON b.id = pa.bill_id
        JOIN ap_bill_lines bl ON bl.bill_id = b.id
        JOIN accounts a ON a.id = bl.account_id
       WHERE p.organization_id = ${org}
         AND p.status = 'posted'
         AND p.payment_date BETWEEN ${from}::date AND ${to}::date
         AND p.method <> 'credit_card'
         AND bank.normal_balance = 'debit'
         AND a.form_1099_box IS NOT NULL
      UNION ALL
      SELECT t.vendor_id, a.form_1099_box, l.amount * t.exchange_rate
        FROM bank_transactions t
        JOIN bank_transaction_lines l ON l.transaction_id = t.id
        JOIN accounts bank ON bank.id = t.bank_account_id
        JOIN accounts a ON a.id = l.account_id
       WHERE t.organization_id = ${org}
         AND t.status = 'posted'
         AND t.type IN ('expense', 'check')
         AND t.vendor_id IS NOT NULL
         AND t.txn_date BETWEEN ${from}::date AND ${to}::date
         AND t.method IS DISTINCT FROM 'credit_card'
         AND bank.normal_balance = 'debit'
         AND a.form_1099_box IS NOT NULL
    ) paid
    GROUP BY vendor_id, box
  `);
}

function emptyBoxes(): Record<Form1099Box, Decimal> {
  return Object.fromEntries(FORM_1099_BOXES.map((b) => [b, money(0)])) as Record<Form1099Box, Decimal>;
}

function mailingAddress(addresses: unknown): string[] {
  const list = Array.isArray(addresses) ? (addresses as Address[]) : [];
  const a = list.find((x) => x.type === "mailing") ?? list.find((x) => x.type === "billing") ?? list.find((x) => x.type === "remit") ?? list[0];
  return addressLines(a);
}

/** The report, with full TINs for the CSV export when `withTin` (accountant and up). */
async function build(ctx: Ctx, input: z.input<typeof Form1099ReportSchema>, withTin: boolean) {
  const f = Form1099ReportSchema.parse(input);
  const year = f.year ?? new Date().getFullYear();
  const threshold = f.threshold ?? default1099Threshold(year);
  const org = ctx.actor.organizationId;

  const paid = await paidByVendorAndBox(ctx, year);
  const byVendor = new Map<string, Record<Form1099Box, Decimal>>();
  for (const r of paid) {
    const boxes = byVendor.get(r.vendor_id) ?? emptyBoxes();
    boxes[r.box] = boxes[r.box].plus(money(r.amount));
    byVendor.set(r.vendor_id, boxes);
  }
  // Vendors marked 1099 show up even when nothing was paid to them yet.
  const vendorRows = await ctx.tx
    .select()
    .from(vendors)
    .where(
      and(
        eq(vendors.organizationId, org),
        byVendor.size ? or(eq(vendors.is1099Vendor, true), inArray(vendors.id, [...byVendor.keys()])) : eq(vendors.is1099Vendor, true)
      )
    )
    .orderBy(asc(vendors.name));

  const totals = emptyBoxes();
  const list = vendorRows.map((v) => {
    const raw = byVendor.get(v.id) ?? emptyBoxes();
    const boxes = Object.fromEntries(FORM_1099_BOXES.map((b) => [b, raw[b].toDecimalPlaces(2, Decimal.ROUND_HALF_UP)])) as Record<Form1099Box, Decimal>;
    const total = FORM_1099_BOXES.reduce((acc, b) => acc.plus(boxes[b]), money(0));
    const reportable = v.is1099Vendor && FORM_1099_BOXES.some((b) => boxes[b].gte(thresholdFor(b, threshold)) && boxes[b].gt(0));
    const digits = (v.tin ?? "").replace(/\D/g, "");
    const issues: string[] = [];
    if (!v.is1099Vendor && total.gt(0)) issues.push("Paid on 1099 accounts but not marked as a 1099 vendor");
    if (reportable && digits.length !== 9) issues.push("No valid TIN");
    if (reportable && !v.w9OnFile) issues.push("No W-9 on file");
    if (reportable && mailingAddress(v.addresses).length === 0) issues.push("No mailing address");
    if (reportable) for (const b of FORM_1099_BOXES) totals[b] = totals[b].plus(boxes[b]);
    return {
      row: {
        vendorId: v.id,
        name: v.name,
        is1099Vendor: v.is1099Vendor,
        w9OnFile: v.w9OnFile,
        tinLast4: digits.length >= 4 ? digits.slice(-4) : null,
        addressLines: mailingAddress(v.addresses),
        boxes: Object.fromEntries(FORM_1099_BOXES.map((b) => [b, toDbMoney(boxes[b])])) as Record<Form1099Box, string>,
        total: toDbMoney(total),
        reportable,
        issues,
      } satisfies Form1099Vendor,
      tin: withTin ? v.tin : null,
    };
  });

  const mapped = await ctx.tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, box: accounts.form1099Box })
    .from(accounts)
    .where(and(eq(accounts.organizationId, org), sql`${accounts.form1099Box} IS NOT NULL`))
    .orderBy(asc(accounts.code));

  return {
    year,
    threshold: toDbMoney(threshold),
    list: f.reportableOnly ? list.filter((x) => x.row.reportable) : list,
    totals: Object.fromEntries(FORM_1099_BOXES.map((b) => [b, toDbMoney(totals[b])])) as Record<Form1099Box, string>,
    mappedAccounts: mapped.map((m) => ({ ...m, box: m.box as Form1099Box })),
  };
}

export async function form1099Report(ctx: Ctx, input: z.input<typeof Form1099ReportSchema> = {}): Promise<Form1099Report> {
  requirePermission(ctx.actor, "read", "viewer", "run the 1099 report");
  const r = await build(ctx, input, false);
  return {
    year: r.year,
    threshold: r.threshold,
    boxLabels: FORM_1099_BOX_LABELS,
    vendors: r.list.map((x) => x.row),
    totals: r.totals,
    mappedAccounts: r.mappedAccounts,
  };
}

/** Reportable vendors with full TINs, for filing. Accountant and up; every export is audited. */
export async function form1099Export(ctx: Ctx, input: z.input<typeof Form1099ReportSchema> = {}) {
  requirePermission(ctx.actor, "read", "accountant", "export 1099s with taxpayer ids");
  const r = await build(ctx, { ...input, reportableOnly: true }, true);
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "reports.1099.exported",
      entityType: "report",
      metadata: { year: r.year, threshold: r.threshold, vendors: r.list.length },
    },
    ctx.tx
  );
  return { year: r.year, rows: r.list.map((x) => ({ ...x.row, tin: x.tin })) };
}

/** Name the 1099 box an expense account's vendor payments report in (or clear it). */
export async function setAccount1099Box(ctx: Ctx, input: z.input<typeof Set1099BoxSchema>) {
  requirePermission(ctx.actor, "write", "accountant", "map accounts to 1099 boxes");
  const d = Set1099BoxSchema.parse(input);
  const [a] = await ctx.tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, d.id), eq(accounts.organizationId, ctx.actor.organizationId)))
    .for("update");
  if (!a) throw notFound("Account");
  if (d.box && (a.category !== "income_statement" || a.normalBalance !== "debit" || a.subcategory === "operating_revenue" || a.subcategory === "other_revenue")) {
    throw new AppError("invalid_input", `${a.code} ${a.name} isn't an expense account; only expense accounts report on 1099s.`);
  }
  await ctx.tx.update(accounts).set({ form1099Box: d.box, updatedAt: sql`now()` }).where(eq(accounts.id, a.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "gl.account.1099_box_set",
      entityType: "account",
      entityId: a.id,
      metadata: { code: a.code, before: a.form1099Box, after: d.box },
    },
    ctx.tx
  );
  return { id: a.id, code: a.code, name: a.name, box: d.box };
}
