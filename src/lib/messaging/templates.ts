import type { EmailTemplateKey, EmailTemplates } from "@/lib/db/schema";
import { escapeHtml } from "@/lib/email";

/**
 * Email templates: a subject and a plain-text body per document type, with
 * placeholders in braces. Companies override any of them in Settings →
 * Email; the rest use these defaults.
 *
 *   {name}       the customer's or vendor's name
 *   {company}    the sending company
 *   {number}     the document number
 *   {total}      the document total
 *   {balance}    what's still owed (invoices, statements)
 *   {date}       the document (or statement) date
 *   {due_date}   the due date (invoices)
 *   {due_status} "is due on Oct 20, 2026" or "was due on Oct 1, 2026, 19 days ago"
 */

export const TEMPLATE_KEYS: EmailTemplateKey[] = ["invoice", "reminder", "estimate", "sales_receipt", "credit_memo", "statement", "purchase_order"];

export const TEMPLATE_LABELS: Record<EmailTemplateKey, string> = {
  invoice: "Invoice",
  reminder: "Payment reminder",
  estimate: "Estimate",
  sales_receipt: "Sales receipt",
  credit_memo: "Credit memo",
  statement: "Statement",
  purchase_order: "Purchase order",
};

export const PLACEHOLDERS = ["name", "company", "number", "total", "balance", "date", "due_date", "due_status"] as const;
export type TemplateVars = Partial<Record<(typeof PLACEHOLDERS)[number], string>>;

export const DEFAULT_TEMPLATES: Record<EmailTemplateKey, { subject: string; body: string }> = {
  invoice: {
    subject: "Invoice {number} from {company}",
    body: "Hi {name},\n\nHere's invoice {number} for {total}, due {due_date}. The PDF is attached.\n\nThank you for your business.\n{company}",
  },
  reminder: {
    subject: "Payment reminder: invoice {number} from {company}",
    body: "Hi {name},\n\nA friendly reminder that invoice {number} for {balance} {due_status}. The PDF is attached.\n\nIf you've already paid, thank you, and please disregard this note.\n{company}",
  },
  estimate: {
    subject: "Estimate {number} from {company}",
    body: "Hi {name},\n\nHere's estimate {number} for {total}. The PDF is attached. Let us know if you have any questions.\n\n{company}",
  },
  sales_receipt: {
    subject: "Receipt {number} from {company}",
    body: "Hi {name},\n\nThank you for your payment of {total}. Your receipt {number} is attached.\n\n{company}",
  },
  credit_memo: {
    subject: "Credit memo {number} from {company}",
    body: "Hi {name},\n\nWe've issued credit memo {number} for {total}. The PDF is attached.\n\n{company}",
  },
  statement: {
    subject: "Your statement from {company}",
    body: "Hi {name},\n\nYour statement through {date} is attached. Balance: {balance}.\n\nThank you,\n{company}",
  },
  purchase_order: {
    subject: "Purchase order {number} from {company}",
    body: "Hi {name},\n\nPlease find purchase order {number} for {total} attached.\n\nThank you,\n{company}",
  },
};

export function templateFor(templates: EmailTemplates, key: EmailTemplateKey) {
  return templates[key] ?? DEFAULT_TEMPLATES[key];
}

/** Fill the placeholders; unknown ones stay as typed. */
export function fill(text: string, vars: TemplateVars): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? (vars[key as keyof TemplateVars] ?? "") : whole));
}

/** The plain-text body as a simple HTML email under the company's name. */
export function emailHtml(company: string, body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:system-ui,-apple-system,sans-serif;color:#1c2541;line-height:1.55">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e3df;border-radius:10px;padding:28px">
<div style="font-weight:600;font-size:16px;letter-spacing:0.04em;border-bottom:1px solid #e3e3df;padding-bottom:12px;margin-bottom:18px">${escapeHtml(company)}</div>
${paragraphs}
</div>
<p style="max-width:560px;margin:12px auto 0;font-size:11px;color:#8a8f9c;text-align:center">Sent with Groundworks</p>
</body></html>`;
}
