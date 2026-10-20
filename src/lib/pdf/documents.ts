import type { ReactElement } from "react";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, type Address } from "@/lib/db/schema";
import { requirePermission, type Ctx } from "@/lib/actor";
import { getCreditMemo } from "@/lib/ar/credit-memos";
import { getEstimate } from "@/lib/ar/estimates";
import { getInvoice } from "@/lib/ar/invoices";
import { getSalesReceipt } from "@/lib/ar/sales-receipts";
import { customerStatement, listStatements, ListStatementsSchema, StatementSchema, type Statement } from "@/lib/ar/statements";
import { loadCompanyProfile } from "@/lib/company/profile";
import { formatMoney, money } from "@/lib/money";
import { id } from "@/lib/schemas";
import {
  addressLines,
  pdfDate,
  salesDocument,
  statements,
  type Pdf,
  type PdfCompany,
  type PdfParty,
  type PdfRow,
  type SalesDocPdf,
  type StatementPdf,
} from "./templates";

/**
 * Customer-facing PDFs: sales documents and statements. Each loads its
 * data through the normal services (so the same permission and tenancy
 * checks apply), then renders. Reads only; nothing is written.
 */

export type PdfFile = { fileName: string; contentType: "application/pdf"; bytes: Buffer };
export const PDF_DOC_KINDS = ["invoice", "estimate", "sales_receipt", "credit_memo"] as const;
export type PdfDocKind = (typeof PDF_DOC_KINDS)[number];

export const DocumentPdfSchema = z.object({ id });

/** ESM-only library, loaded on first use so CommonJS callers (scripts) work too. */
async function render(build: (P: Pdf) => ReactElement): Promise<Buffer> {
  const P = await import("@react-pdf/renderer");
  return P.renderToBuffer(build(P) as Parameters<Pdf["renderToBuffer"]>[0]);
}

async function company(ctx: Ctx): Promise<PdfCompany> {
  const { profile, companyName } = await loadCompanyProfile(ctx);
  return {
    name: profile?.legalName || companyName,
    address: profile?.address ?? {},
    phone: profile?.phone ?? null,
    email: profile?.email ?? null,
    website: profile?.website ?? null,
    taxId: profile?.taxId ?? null,
    footer: profile?.documentFooter ?? null,
    logo:
      profile?.logoData && profile.logoContentType
        ? { data: Buffer.from(profile.logoData, "base64"), format: profile.logoContentType === "image/png" ? "png" : "jpg" }
        : null,
  };
}

function billTo(c: { name: string; email: string | null; addresses: unknown }): PdfParty {
  const list = Array.isArray(c.addresses) ? (c.addresses as Address[]) : [];
  const billing = list.find((a) => a.type === "billing") ?? list[0];
  return { name: c.name, addressLines: addressLines(billing), email: c.email };
}

async function customerParty(ctx: Ctx, customerId: string | null): Promise<PdfParty | null> {
  if (!customerId) return null;
  const [c] = await ctx.tx
    .select({ name: customers.name, email: customers.email, addresses: customers.addresses })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, ctx.actor.organizationId)));
  return c ? billTo(c) : null;
}

function stamp(status: string): string | null {
  if (status === "draft") return "DRAFT";
  if (status === "voided") return "VOID";
  return null;
}

function taxRows(fmt: (v: string) => string, d: { taxLines: Array<{ agencyName: string; ratePercent: string; taxAmount: string }>; taxExempt: boolean }): PdfRow[] {
  return d.taxLines
    .filter((t) => !money(t.taxAmount).isZero() || d.taxExempt)
    .map((t) => ({ label: `${t.agencyName} ${money(t.ratePercent).toString()}%${d.taxExempt ? " (exempt)" : ""}`, value: fmt(t.taxAmount) }));
}

function lineRows(lines: Array<{ itemName: string | null; description: string | null; quantity: string; unitPrice: string; amount: string }>) {
  return lines.map((l) => ({ item: l.itemName, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount }));
}

async function salesDocData(ctx: Ctx, kind: PdfDocKind, docId: string): Promise<{ data: SalesDocPdf; number: string }> {
  if (kind === "invoice") {
    const d = await getInvoice(ctx, { id: docId });
    const fmt = (v: string) => formatMoney(v, { currency: d.currency });
    const posted = d.status === "open" || d.status === "paid";
    const paid = money(d.totalAmount).minus(money(d.openBalance));
    return {
      number: d.invoiceNumber,
      data: {
        title: "Invoice",
        stamp: stamp(d.status),
        partyLabel: "BILL TO",
        party: await customerParty(ctx, d.customerId),
        meta: [
          { label: "Invoice #", value: d.invoiceNumber },
          { label: "Date", value: pdfDate(d.invoiceDate) },
          { label: "Due date", value: pdfDate(d.dueDate) },
          ...(d.poNumber ? [{ label: "PO #", value: d.poNumber }] : []),
          ...(posted ? [{ label: "Balance due", value: fmt(d.openBalance), strong: true }] : []),
        ],
        currency: d.currency,
        lines: lineRows(d.lines),
        totals: [
          { label: "Subtotal", value: fmt(d.subtotalAmount) },
          ...taxRows(fmt, d),
          { label: "Total", value: fmt(d.totalAmount), strong: !posted },
          ...(posted && paid.gt(0) ? [{ label: "Payments and credits", value: fmt(paid.negated().toString()) }] : []),
          ...(posted ? [{ label: "Balance due", value: fmt(d.openBalance), strong: true }] : []),
        ],
        message: d.memo,
        signature: false,
      },
    };
  }
  if (kind === "estimate") {
    const d = await getEstimate(ctx, { id: docId });
    const fmt = (v: string) => formatMoney(v, { currency: d.currency });
    return {
      number: d.estimateNumber,
      data: {
        title: "Estimate",
        stamp: d.status === "rejected" ? "DECLINED" : null,
        partyLabel: "FOR",
        party: await customerParty(ctx, d.customerId),
        meta: [
          { label: "Estimate #", value: d.estimateNumber },
          { label: "Date", value: pdfDate(d.estimateDate) },
          ...(d.expirationDate ? [{ label: "Valid until", value: pdfDate(d.expirationDate) }] : []),
          ...(d.acceptedDate ? [{ label: "Accepted", value: `${pdfDate(d.acceptedDate)}${d.acceptedBy ? ` by ${d.acceptedBy}` : ""}` }] : []),
        ],
        currency: d.currency,
        lines: lineRows(d.lines),
        totals: [
          { label: "Subtotal", value: fmt(d.subtotalAmount) },
          ...(money(d.taxAmount).isZero() && !d.taxExempt ? [] : [{ label: `Sales tax${d.taxExempt ? " (exempt)" : ""}`, value: fmt(d.taxAmount) }]),
          { label: "Total", value: fmt(d.totalAmount), strong: true },
        ],
        message: d.memo,
        signature: d.status === "pending",
      },
    };
  }
  if (kind === "sales_receipt") {
    const d = await getSalesReceipt(ctx, { id: docId });
    const fmt = (v: string) => formatMoney(v, { currency: d.currency });
    return {
      number: d.receiptNumber,
      data: {
        title: "Sales receipt",
        stamp: stamp(d.status),
        partyLabel: "SOLD TO",
        party: await customerParty(ctx, d.customerId),
        meta: [
          { label: "Receipt #", value: d.receiptNumber },
          { label: "Date", value: pdfDate(d.receiptDate) },
          { label: "Payment", value: d.method.replace(/_/g, " ") },
          ...(d.reference ? [{ label: "Reference", value: d.reference }] : []),
        ],
        currency: d.currency,
        lines: lineRows(d.lines),
        totals: [
          { label: "Subtotal", value: fmt(d.subtotalAmount) },
          ...taxRows(fmt, d),
          { label: "Total paid", value: fmt(d.totalAmount), strong: true },
        ],
        message: d.memo,
        signature: false,
      },
    };
  }
  const d = await getCreditMemo(ctx, { id: docId });
  const fmt = (v: string) => formatMoney(v, { currency: d.currency });
  const live = d.status === "open" || d.status === "applied";
  return {
    number: d.memoNumber,
    data: {
      title: "Credit memo",
      stamp: stamp(d.status),
      partyLabel: "CREDIT TO",
      party: await customerParty(ctx, d.customerId),
      meta: [
        { label: "Credit #", value: d.memoNumber },
        { label: "Date", value: pdfDate(d.memoDate) },
      ],
      currency: d.currency,
      lines: lineRows(d.lines),
      totals: [
        { label: "Subtotal", value: fmt(d.subtotalAmount) },
        ...taxRows(fmt, d),
        { label: "Total credit", value: fmt(d.totalAmount), strong: !live },
        ...(live ? [{ label: "Credit remaining", value: fmt(d.remaining), strong: true }] : []),
      ],
      message: d.memo,
      signature: false,
    },
  };
}

const FILE_PREFIX: Record<PdfDocKind, string> = {
  invoice: "Invoice",
  estimate: "Estimate",
  sales_receipt: "SalesReceipt",
  credit_memo: "CreditMemo",
};

export async function documentPdf(ctx: Ctx, kind: PdfDocKind, docId: string): Promise<PdfFile> {
  requirePermission(ctx.actor, "read", "viewer", "download documents");
  const { data, number } = await salesDocData(ctx, kind, docId);
  const co = await company(ctx);
  const bytes = await render((P) => salesDocument(P, co, data));
  return { fileName: `${FILE_PREFIX[kind]}_${number}.pdf`, contentType: "application/pdf", bytes };
}

function statementData(s: Statement): StatementPdf {
  const fmt = (v: string) => formatMoney(v, { currency: s.customer.currency });
  const due = money(s.closingBalance);
  return {
    party: billTo(s.customer),
    currency: s.customer.currency,
    meta: [
      { label: "Statement date", value: pdfDate(s.to) },
      { label: "Activity since", value: pdfDate(s.from) },
      { label: due.lt(0) ? "Credit balance" : "Amount due", value: fmt(due.abs().toString()), strong: true },
    ],
    openingDate: s.from,
    openingBalance: s.openingBalance,
    lines: s.lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, balance: l.balance })),
    closingBalance: s.closingBalance,
    aging: !s.agingTiesOut ? [] : [
      { label: "Current", value: s.aging.current },
      { label: "1 to 30 days", value: s.aging.days1to30 },
      { label: "31 to 60 days", value: s.aging.days31to60 },
      { label: "61 to 90 days", value: s.aging.days61to90 },
      { label: "Over 90 days", value: s.aging.over90 },
      { label: "Amount due", value: s.closingBalance },
    ],
  };
}

const safe = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "Customer";

export async function statementPdf(ctx: Ctx, input: z.input<typeof StatementSchema>): Promise<PdfFile> {
  const s = await customerStatement(ctx, input);
  const co = await company(ctx);
  const bytes = await render((P) => statements(P, co, [statementData(s)]));
  return { fileName: `Statement_${safe(s.customer.name)}_${s.to}.pdf`, contentType: "application/pdf", bytes };
}

/** Every customer's statement in one PDF (the list Statements shows). */
export async function statementsPdf(ctx: Ctx, input: z.input<typeof ListStatementsSchema>): Promise<PdfFile | null> {
  const list = await listStatements(ctx, input);
  if (list.length === 0) return null;
  const co = await company(ctx);
  const bytes = await render((P) => statements(P, co, list.map(statementData)));
  return { fileName: `Statements_${list[0].to}.pdf`, contentType: "application/pdf", bytes };
}

/** API shape: the file as base64 inside JSON. */
export function asJson(f: PdfFile) {
  return { fileName: f.fileName, contentType: f.contentType, sizeBytes: f.bytes.length, base64: f.bytes.toString("base64") };
}
