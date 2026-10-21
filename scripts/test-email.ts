/**
 * End-to-end: emailing documents. Invoices, estimates, receipts, credit
 * memos, statements, and purchase orders go out with their PDFs under the
 * company's name; templates and settings; who may send and to whom (agents
 * only to saved addresses); failed sends logged; automatic payment
 * reminders on the company's schedule; and the email service's signed
 * delivery events (delivered, opened, bounced).
 *
 *   npx tsx scripts/test-email.ts
 */
import { createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { arInvoices, auditLog, companyProfiles, emailMessages, purchaseOrders } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as pos from "../src/lib/ap/purchase-orders";
import * as memos from "../src/lib/ar/credit-memos";
import * as estimates from "../src/lib/ar/estimates";
import * as invoices from "../src/lib/ar/invoices";
import * as payments from "../src/lib/ar/payments";
import * as receipts from "../src/lib/ar/sales-receipts";
import { memoryOutbox } from "../src/lib/email";
import { dueReminders, runRemindersForOrg } from "../src/lib/messaging/reminders";
import * as mail from "../src/lib/messaging/service";
import { applyEmailEvent, verifyWebhook } from "../src/lib/messaging/webhooks";
import * as parties from "../src/lib/parties/service";
import { POST as webhookRoute } from "../src/app/api/webhooks/resend/route";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

async function main() {
  const t = await createTestOrg("email-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const admin = t.as("admin");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const agent: Actor = { ...t.as("bookkeeper"), kind: "agent", userId: null, agentId: null, agentName: "Mailer" };
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);
  const sales = account(t, "4100");
  const supplies = account(t, "6200");
  const last = () => memoryOutbox[memoryOutbox.length - 1];

  await db.insert(companyProfiles).values({ organizationId: t.org.id, legalName: "Acme Books LLC", email: "billing@acmebooks.test" });
  const acme = await run(owner, (ctx) =>
    parties.createCustomer(ctx, { name: "Acme Retail", email: "ap@acme.test", contacts: [{ name: "Owner", email: "owner@acme.test" }] })
  );
  const silent = await run(owner, (ctx) => parties.createCustomer(ctx, { name: "No Email Co" }));
  const lumber = await run(owner, (ctx) => parties.createVendor(ctx, { name: "Lumber Yard", email: "orders@lumber.test" }));
  const inv = await run(owner, (ctx) =>
    invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-03-01", dueDate: "2026-03-31", lines: [{ description: "Consulting", unitPrice: "500", accountId: sales.id }], post: true })
  );
  const send = (actor: Actor, input: mail.SendEmailInput) => run(actor, (ctx) => mail.sendDocumentEmail(ctx, input));

  section("Setup");
  await check("without an email service nothing is sent", async () => {
    delete process.env.EMAIL_TRANSPORT;
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    await expectError(() => send(owner, { documentType: "invoice", documentId: inv.id }), "invalid_state");
    if (saved) process.env.RESEND_API_KEY = saved;
    process.env.EMAIL_TRANSPORT = "memory";
  });

  section("Invoices");
  await check("the draft uses the saved address and the default template", async () => {
    const d = await run(viewer, (ctx) => mail.emailDraft(ctx, { documentType: "invoice", documentId: inv.id }));
    assertEq(d.to.join(), "ap@acme.test", "primary address");
    assertEq(d.onFile.join(), "ap@acme.test,owner@acme.test", "saved addresses");
    assertEq(d.subject, `Invoice ${inv.invoiceNumber} from Acme Books LLC`, "subject");
    assert(d.message.includes("for $500.00, due Mar 31, 2026"), d.message);
    assertEq(d.replyTo, "billing@acmebooks.test", "replies go to the company");
  });
  await check("a bookkeeper sends it: PDF attached, company name, reply-to; the invoice is marked sent and it's audited", async () => {
    const m = await send(bookkeeper, { documentType: "invoice", documentId: inv.id });
    assertEq(m.status, "sent", "status");
    const e = last();
    assertEq(String(e.to), "ap@acme.test", "to");
    assertEq(e.fromName, "Acme Books LLC", "from name");
    assertEq(e.replyTo, "billing@acmebooks.test", "reply-to");
    assertEq(e.attachments?.[0].filename, `Invoice_${inv.invoiceNumber}.pdf`, "attachment");
    assertEq(e.attachments?.[0].content.subarray(0, 5).toString(), "%PDF-", "a PDF");
    assert(e.html.includes("Acme Books LLC") && e.html.includes("$500.00"), "HTML body");
    assertEq(m.providerId, e.id, "provider id kept");
    const [row] = await db.select().from(arInvoices).where(eq(arInvoices.id, inv.id));
    assert(row.sentAt, "invoice marked sent");
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, inv.id), eq(auditLog.event, "email.sent")));
    assertEq(audits.length, 1, "audited");
  });
  await check("viewers can't send; drafts can't be emailed", async () => {
    await expectError(() => send(viewer, { documentType: "invoice", documentId: inv.id }), "forbidden");
    const draft = await run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: acme.id, invoiceDate: "2026-03-02", lines: [{ description: "x", unitPrice: "5", accountId: sales.id }] }));
    await expectError(() => send(owner, { documentType: "invoice", documentId: draft.id }), "invalid_state");
  });

  section("Who can send where");
  await check("agents send only to addresses saved on the customer; people to any", async () => {
    const a = await send(agent, { documentType: "invoice", documentId: inv.id, to: ["owner@acme.test"] });
    assertEq(a.status, "sent", "a saved contact");
    await expectError(() => send(agent, { documentType: "invoice", documentId: inv.id, to: ["someone@else.test"] }), "forbidden");
    await expectError(() => send(agent, { documentType: "invoice", documentId: inv.id, cc: ["spy@else.test"] }), "forbidden");
    const p = await send(owner, { documentType: "invoice", documentId: inv.id, to: ["someone@else.test"], cc: ["owner@acme.test"] });
    assertEq(p.status, "sent", "people may");
    assertEq(String(last().cc), "owner@acme.test", "cc");
  });
  await check("a customer with no email: type one in, or nothing goes", async () => {
    const i2 = await run(owner, (ctx) => invoices.createInvoice(ctx, { customerId: silent.id, invoiceDate: "2026-03-05", lines: [{ description: "x", unitPrice: "10", accountId: sales.id }], post: true }));
    await expectError(() => send(owner, { documentType: "invoice", documentId: i2.id }), "invalid_state");
    await expectError(() => send(agent, { documentType: "invoice", documentId: i2.id, to: ["x@y.test"] }), "forbidden");
    assertEq((await send(owner, { documentType: "invoice", documentId: i2.id, to: ["x@y.test"] })).status, "sent", "typed in");
  });
  await check("a refused send is logged as failed, with the reason", async () => {
    const m = await send(owner, { documentType: "invoice", documentId: inv.id, to: ["nobody@fail.test"] });
    assertEq(m.status, "failed", "status");
    assert(m.error?.includes("refused"), String(m.error));
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, inv.id), eq(auditLog.event, "email.failed")));
    assertEq(audits.length, 1, "audited");
  });

  section("Settings and templates");
  await check("admins set the reply-to, a copy address, and templates; null restores a default", async () => {
    await expectError(() => run(accountant, (ctx) => mail.updateEmailSettings(ctx, { replyTo: "x@y.test" })), "forbidden");
    const s = await run(admin, (ctx) =>
      mail.updateEmailSettings(ctx, { replyTo: "ar@acmebooks.test", copyTo: "records@acmebooks.test", templates: { invoice: { subject: "Bill {number} for {name}", body: "Total {total}. {unknown} stays." } } })
    );
    assertEq(s.customized.join(), "invoice", "customized");
    const m = await send(owner, { documentType: "invoice", documentId: inv.id });
    assertEq(m.subject, `Bill ${inv.invoiceNumber} for Acme Retail`, "template subject");
    assertEq(m.body, "Total $500.00. {unknown} stays.", "body placeholders");
    assertEq(last().replyTo, "ar@acmebooks.test", "reply-to");
    assertEq(String(last().bcc), "records@acmebooks.test", "copy");
    const custom = await send(owner, { documentType: "invoice", documentId: inv.id, subject: "About {number}", message: "See attached." });
    assertEq(custom.subject, `About ${inv.invoiceNumber}`, "typed subject is filled too");
    await run(admin, (ctx) => mail.updateEmailSettings(ctx, { templates: { invoice: null }, copyTo: null }));
    const back = await run(viewer, (ctx) => mail.emailDraft(ctx, { documentType: "invoice", documentId: inv.id }));
    assert(back.subject.startsWith("Invoice "), back.subject);
  });

  section("Every document type");
  await check("estimate, sales receipt, credit memo, statement, and purchase order", async () => {
    const est = await run(owner, (ctx) => estimates.createEstimate(ctx, { customerId: acme.id, estimateDate: "2026-03-03", lines: [{ description: "Plan", unitPrice: "900", accountId: sales.id }] }));
    assertEq((await send(owner, { documentType: "estimate", documentId: est.id })).status, "sent", "estimate");
    assertEq(last().attachments?.[0].filename, `Estimate_${est.estimateNumber}.pdf`, "estimate PDF");
    const rec = await run(owner, (ctx) => receipts.createSalesReceipt(ctx, { customerId: acme.id, receiptDate: "2026-03-04", method: "cash", lines: [{ description: "Walk-in", unitPrice: "20", accountId: sales.id }], post: true }));
    assertEq((await send(owner, { documentType: "sales_receipt", documentId: rec.id })).subject, `Receipt ${rec.receiptNumber} from Acme Books LLC`, "receipt");
    const cm = await run(owner, (ctx) => memos.createCreditMemo(ctx, { customerId: acme.id, memoDate: "2026-03-06", lines: [{ description: "Discount", unitPrice: "25", accountId: sales.id }], post: true }));
    assertEq((await send(owner, { documentType: "credit_memo", documentId: cm.id })).status, "sent", "credit memo");
    const st = await send(owner, { documentType: "statement", documentId: acme.id, statementFrom: "2026-03-01", statementTo: "2026-03-31" });
    assert(st.body.includes("through Mar 31, 2026") && st.attachmentName?.startsWith("Statement_Acme_Retail"), `${st.body} ${st.attachmentName}`);
    const po = await run(owner, (ctx) => pos.createPurchaseOrder(ctx, { vendorId: lumber.id, poDate: "2026-03-07", lines: [{ accountId: supplies.id, description: "Paper", unitCost: "40" }], submit: true }));
    const approved = po.status === "open" ? po : await run(owner, (ctx) => pos.approvePurchaseOrder(ctx, { id: po.id }));
    assertEq(approved.status, "open", "approved");
    const pm = await send(agent, { documentType: "purchase_order", documentId: po.id });
    assertEq(String(pm.to), "orders@lumber.test", "vendor's saved address");
    const [p] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    assert(p.sentAt, "PO marked sent");
  });

  section("Payment reminders");
  await check("on the schedule: three days before, on the due date, then the latest day reached, once each", async () => {
    await run(admin, (ctx) => mail.updateEmailSettings(ctx, { remindersEnabled: true, reminderDays: [30, -3, 0, 7] }));
    const due = (asOf: string) => run(viewer, (ctx) => dueReminders(ctx, asOf, [-3, 0, 7, 30]));
    assertEq((await due("2026-03-27")).length, 0, "four days out: nothing");
    assertEq((await due("2026-03-28")).map((d) => d.offset).join(), "-3", "three days before");
    let r = await runRemindersForOrg(t.org.id, "2026-03-28");
    assertEq(r.sent, 1, "sent");
    assertEq(last().subject, `Payment reminder: invoice ${inv.invoiceNumber} from Acme Books LLC`, "reminder subject");
    assert(last().text.includes("is due on Mar 31, 2026"), last().text);
    r = await runRemindersForOrg(t.org.id, "2026-03-29");
    assertEq(r.sent, 0, "not twice");
    r = await runRemindersForOrg(t.org.id, "2026-04-01");
    assertEq(r.sent, 1, "due date reached");
    assert(last().text.includes("was due on Mar 31, 2026, 1 day ago"), last().text);
    assertEq((await due("2026-05-20")).length, 0, "a day missed by more than a week is skipped");
    r = await runRemindersForOrg(t.org.id, "2026-05-01");
    assertEq(r.sent, 1, "thirty days late");
    const sent = await db.select().from(emailMessages).where(and(eq(emailMessages.documentId, inv.id), eq(emailMessages.kind, "reminder")));
    assertEq(sent.map((m) => m.reminderOffset).sort((a, b) => Number(a) - Number(b)).join(), "-3,1,31", "days late when sent");
  });
  await check("a person or agent can remind by hand; paid invoices and disabled companies get none", async () => {
    const m = await send(agent, { documentType: "invoice", documentId: inv.id, reminder: true });
    assertEq(m.kind, "reminder", "manual reminder");
    const open = (await run(viewer, (ctx) => invoices.getInvoice(ctx, { id: inv.id }))).openBalance;
    await run(owner, (ctx) => payments.createCustomerPayment(ctx, { customerId: acme.id, paymentDate: "2026-05-02", method: "check", applications: [{ invoiceId: inv.id, amount: open }], post: true }));
    await expectError(() => send(owner, { documentType: "invoice", documentId: inv.id, reminder: true }), "invalid_state");
    assertEq((await run(viewer, (ctx) => dueReminders(ctx, "2026-05-02", [0, 7, 30]))).length, 0, "paid");
    await expectError(() => send(owner, { documentType: "estimate", documentId: inv.id, reminder: true }), "invalid_input");
    await run(admin, (ctx) => mail.updateEmailSettings(ctx, { remindersEnabled: false }));
    assertEq((await runRemindersForOrg(t.org.id, "2026-05-02")).checked, 0, "off");
  });

  section("Delivery events");
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const sign = (id: string, ts: number, body: string) =>
    `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;
  await check("signatures: valid, tampered, stale", async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "x" } });
    assert(verifyWebhook(secret, { id: "msg_1", timestamp: String(now), signature: `v1,bogus ${sign("msg_1", now, body)}` }, body), "valid");
    assert(!verifyWebhook(secret, { id: "msg_1", timestamp: String(now), signature: sign("msg_1", now, body) }, `${body} `), "tampered");
    assert(!verifyWebhook(secret, { id: "msg_1", timestamp: String(now - 600), signature: sign("msg_1", now - 600, body) }, body), "stale");
    assert(!verifyWebhook(secret, { id: null, timestamp: String(now), signature: sign("msg_1", now, body) }, body), "missing id");
  });
  await check("delivered, opened twice, then bounced (audited); unknown ids are ignored", async () => {
    const [m] = await db.select().from(emailMessages).where(and(eq(emailMessages.documentId, inv.id), eq(emailMessages.status, "sent"))).limit(1);
    const id = m.providerId!;
    await applyEmailEvent({ type: "email.delivered", data: { email_id: id } });
    await applyEmailEvent({ type: "email.opened", data: { email_id: id } });
    await applyEmailEvent({ type: "email.opened", data: { email_id: id } });
    let [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, m.id));
    assertEq(row.status, "delivered", "delivered");
    assertEq(row.openCount, 2, "opens");
    assert(row.openedAt, "first open");
    await applyEmailEvent({ type: "email.bounced", data: { email_id: id, bounce: { message: "Mailbox full" } } });
    await applyEmailEvent({ type: "email.delivered", data: { email_id: id } });
    [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, m.id));
    assertEq(row.status, "bounced", "a bounce sticks");
    assertEq(row.error, "Mailbox full", "reason");
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, inv.id), eq(auditLog.event, "email.bounced")));
    assertEq(audits.length, 1, "bounce audited");
    assertEq((await applyEmailEvent({ type: "email.delivered", data: { email_id: "nope" } })).matched, false, "unknown");
  });
  await check("the webhook route checks the signature", async () => {
    const [m] = await db.select().from(emailMessages).where(and(eq(emailMessages.documentType, "estimate"), eq(emailMessages.organizationId, t.org.id)));
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: m.providerId } });
    const now = Math.floor(Date.now() / 1000);
    const req = (sig: string) => new Request("http://x/api/webhooks/resend", { method: "POST", body, headers: { "svix-id": "msg_9", "svix-timestamp": String(now), "svix-signature": sig } });
    delete process.env.RESEND_WEBHOOK_SECRET;
    assertEq((await webhookRoute(req(sign("msg_9", now, body)))).status, 503, "not configured");
    process.env.RESEND_WEBHOOK_SECRET = secret;
    assertEq((await webhookRoute(req("v1,AAAA"))).status, 401, "bad signature");
    assertEq((await webhookRoute(req(sign("msg_9", now, body)))).status, 200, "accepted");
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, m.id));
    assertEq(row.status, "delivered", "applied");
  });

  section("History");
  await check("one document's sends, newest first, with who sent them", async () => {
    const h = await run(viewer, (ctx) => mail.listEmails(ctx, { documentType: "invoice", documentId: inv.id, limit: 50 }));
    assert(h.data.length >= 9, `count ${h.data.length}`);
    assert(h.data.some((x) => x.sentByAgent === null && x.sentByEmail), "a person's send");
    const failed = await run(viewer, (ctx) => mail.listEmails(ctx, { status: "failed" }));
    assertEq(failed.data.length, 1, "filter by status");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
