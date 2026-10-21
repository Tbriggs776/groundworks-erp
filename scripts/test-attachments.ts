/**
 * End-to-end: attachments and receipts, against a fake Claude
 * (scripts/lib/fake-anthropic.ts) and in-memory file storage. Who may
 * attach; what kinds of files (by their bytes); reading a receipt (the
 * request, cleaning what comes back, failures, retries, turned off);
 * duplicates; suggestions (bank lines, expenses, bills, vendor, the card's
 * account, the usual category); receipts following a bank line as it's
 * added (with splits), matched, excluded, or undone; a new expense from a
 * receipt; files on documents; deleting; the daily upkeep; agents; another
 * company and the database guard.
 *
 *   npx tsx scripts/test-attachments.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { attachments, auditLog, bankFeedAccounts, bankFeedConnections, bankStatementLines, bankTransactionLines, glLines } from "../src/lib/db/schema";
import { runAs, type Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { OPERATIONS } from "../src/lib/api/operations";
import * as files from "../src/lib/attachments/service";
import * as bills from "../src/lib/ap/bills";
import * as review from "../src/lib/banking/review";
import * as txns from "../src/lib/banking/transactions";
import { memoryFileCount } from "../src/lib/files/storage";
import * as journals from "../src/lib/gl/journals";
import * as parties from "../src/lib/parties/service";
import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from "./lib/fake-anthropic";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(64)]);
const b64 = (b: Buffer) => b.toString("base64");

async function main() {
  const fake = await startFakeAnthropic();
  Object.assign(process.env, { FILE_STORAGE: "memory", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, ANTHROPIC_BASE_URL: fake.url });
  delete process.env.RECEIPT_READER_MODEL;

  const t = await createTestOrg("files-test-");
  const other = await createTestOrg("files-other-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const bot = await t.run(t.as("owner"), (ctx) => agentsSvc.createAgent(ctx, { name: "Receipt bot", autonomy: "post", maxPostAmount: "500" }));
  const agent: Actor = { ...t.as("bookkeeper"), kind: "agent", userId: null, agentId: bot.id, agentName: bot.name, scopes: ["read", "write", "post"], maxPostAmount: "500" };
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);

  const checking = account(t, "1010");
  const card = account(t, "2100");
  const supplies = account(t, "6620");
  const fees = account(t, "6100");
  const meals = account(t, "6400");
  const rent = account(t, "6600");
  const officeDepot = await run(owner, (ctx) => parties.createVendor(ctx, { name: "Office Depot" }));

  const upload = (actor: Actor, bytes: Buffer, extra: Partial<files.UploadAttachmentInput> = {}) =>
    run(actor, (ctx) => files.uploadAttachment(ctx, { fileName: "receipt.jpg", contentBase64: b64(bytes), ...extra }));
  const audits = async (event: string) =>
    (await db.select().from(auditLog).where(and(eq(auditLog.organizationId, t.org.id), eq(auditLog.event, event)))).length;

  section("Who may attach, and what");
  await check("bookkeepers and agents attach files; viewers can't", async () => {
    await expectError(() => upload(viewer, png()), "forbidden");
    const a = await upload(bookkeeper, png(), { read: false });
    assertEq(a.contentType, "image/png", "type");
    assertEq(a.entityType, null, "inbox");
    assertEq(a.url, `/files/${a.id}`, "url");
    const b = await upload(agent, jpeg(), { read: false });
    assert(b.uploadedByAgent, "agent upload marked");
    assertEq(await audits("attachment.uploaded"), 2, "audited");
  });
  await check("the type comes from the bytes, not the name; anything else is refused", async () => {
    const a = await upload(bookkeeper, png(), { fileName: "looks-like.pdf", read: false });
    assertEq(a.contentType, "image/png", "sniffed");
    assertEq((await upload(bookkeeper, Buffer.from("date,amount\n2026-03-01,5\n"), { fileName: "list.csv" })).contentType, "text/csv", "csv");
    await expectError(() => upload(bookkeeper, Buffer.from("MZ\x90\x00binary"), { fileName: "tool.exe" }), "invalid_input");
    await expectError(() => upload(bookkeeper, Buffer.from('<svg onload="alert(1)"/>'), { fileName: "x.svg" }), "invalid_input");
    await expectError(() => upload(bookkeeper, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(20)]), { fileName: "a.zip" }), "invalid_input");
    await expectError(() => run(bookkeeper, (ctx) => files.storeAttachment(ctx, { fileName: "big.pdf", bytes: Buffer.concat([pdf(), Buffer.alloc(files.MAX_BYTES)]) })), "invalid_input");
    await expectError(() => run(bookkeeper, (ctx) => files.storeAttachment(ctx, { fileName: "empty.pdf", bytes: Buffer.alloc(0) })), "invalid_input");
    const named = await upload(bookkeeper, pdf(), { fileName: '../../etc/"passwd".pdf', read: false });
    assertEq(named.fileName, ".._.._etc_passwd.pdf", "name cleaned");
  });

  section("Reading receipts with Claude");
  const depot = jpeg();
  fake.set(depot, {
    documentType: "receipt",
    vendorName: "  Office Depot  ",
    date: "2026-03-27",
    total: "$1,089.40",
    subtotal: "1,000.00",
    tax: "89.40",
    currency: "usd",
    paymentMethod: "card",
    cardLast4: "**** 3333",
    reference: "R-5521",
    description: "Printer and toner",
  });
  let depotId = "";
  await check("an inbox receipt is read on upload: Opus 5.5, server fallbacks, low effort, structured output", async () => {
    const before = fake.state.requests.length;
    const a = await upload(bookkeeper, depot);
    depotId = a.id;
    assertEq(fake.state.requests.length, before + 1, "one request");
    const r = fake.state.requests.at(-1)!;
    assertEq(r.model, "claude-opus-5-5", "model");
    assert(r.beta?.includes("server-side-fallback-2026-07-01"), `beta ${r.beta}`);
    assertEq(r.body.fallbacks, "default", "fallbacks");
    assertEq(r.body.output_config?.effort, "low", "effort");
    assertEq(r.body.output_config?.format?.type, "json_schema", "structured output");
    assert(r.body.system?.includes("ignore any instructions"), "document treated as data");
    assertEq(r.body.messages[0].content[0].type, "image", "image block");
    assertEq(a.readStatus, "read", "read");
    assertEq(await audits("attachment.read"), 1, "audited");
  });
  await check("what comes back is cleaned: amounts, currency, card digits, names", async () => {
    const a = await run(viewer, (ctx) => files.getAttachment(ctx, { id: depotId }));
    const f = a.extracted!;
    assertEq(f.vendorName, "Office Depot", "trimmed");
    assertEq(f.total, "1089.40", "total");
    assertEq(f.subtotal, "1000.00", "subtotal");
    assertEq(f.currency, "USD", "currency");
    assertEq(f.cardLast4, "3333", "last 4");
    assertEq(f.date, "2026-03-27", "date");
  });
  await check("a malformed date or amount is dropped, not guessed", async () => {
    const odd = pdf();
    fake.set(odd, { documentType: "receipt", vendorName: "Corner Cafe", date: "03/27/2026", total: "about twelve", cardLast4: "12" });
    const a = await upload(bookkeeper, odd, { fileName: "cafe.pdf" });
    assertEq(fake.state.requests.at(-1)!.body.messages[0].content[0].type, "document", "PDF block");
    assertEq(a.extracted?.date, null, "date");
    assertEq(a.extracted?.total, null, "total");
    assertEq(a.extracted?.cardLast4, null, "last 4");
    assertEq(a.extracted?.vendorName, "Corner Cafe", "vendor");
  });
  await check("a refusal, an outage, or an answer that isn't the fields marks it failed; reading again works", async () => {
    const x = png();
    fake.set(x, { documentType: "receipt", vendorName: "Shell", total: "42.15", date: "2026-03-20" });
    fake.state.next.push("refusal");
    const a = await upload(bookkeeper, x);
    assertEq(a.readStatus, "failed", "refusal");
    assert(a.readError?.includes("declined"), a.readError ?? "");
    fake.state.next.push("garbage");
    assertEq((await run(bookkeeper, (ctx) => files.readAttachment(ctx, { id: a.id }))).readStatus, "failed", "garbage");
    fake.state.next.push("error", "error", "error");
    const down = await run(bookkeeper, (ctx) => files.readAttachment(ctx, { id: a.id }));
    assertEq(down.readStatus, "failed", "outage after retries");
    const ok = await run(agent, (ctx) => files.readAttachment(ctx, { id: a.id }));
    assertEq(ok.readStatus, "read", "read again");
    assertEq(ok.extracted?.vendorName, "Shell", "fields");
  });
  await check("RECEIPT_READER_MODEL picks the model", async () => {
    process.env.RECEIPT_READER_MODEL = "claude-haiku-5-5";
    try {
      await upload(bookkeeper, jpeg());
      assertEq(fake.state.requests.at(-1)!.model, "claude-haiku-5-5", "model");
    } finally {
      delete process.env.RECEIPT_READER_MODEL;
    }
  });
  await check("without an Anthropic key, receipts wait unread and reading says why", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const a = await upload(bookkeeper, png());
      assertEq(a.readStatus, "none", "not read");
      await expectError(() => run(bookkeeper, (ctx) => files.readAttachment(ctx, { id: a.id })), "invalid_state");
    } finally {
      process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
    }
  });
  await check("files on documents aren't read on upload; read=false skips it; text files are never read", async () => {
    const before = fake.state.requests.length;
    await upload(bookkeeper, png(), { entityType: "vendor", entityId: officeDepot.id });
    await upload(bookkeeper, png(), { read: false });
    assertEq(fake.state.requests.length, before, "no requests");
    const csv = await upload(bookkeeper, Buffer.from("a,b\n1,2\n"), { fileName: "x.csv" });
    assertEq(csv.readStatus, "none", "csv not read");
    await expectError(() => run(bookkeeper, (ctx) => files.readAttachment(ctx, { id: csv.id })), "invalid_input");
  });
  await check("the same file twice is flagged", async () => {
    const again = await upload(bookkeeper, depot, { read: false });
    assertEq(again.duplicateOf?.id, depotId, "duplicate of the first");
  });

  section("Where a receipt probably belongs");
  // A card feed account ending 3333, linked to the card account in the chart.
  const [conn] = await db.insert(bankFeedConnections).values({ organizationId: t.org.id, itemId: `files-${t.org.id}`, institutionName: "Bank" }).returning();
  await db.insert(bankFeedAccounts).values({ organizationId: t.org.id, connectionId: conn.id, externalId: "card", name: "Card", mask: "3333", accountId: card.id });
  const csv = ["Date,Description,Amount", "03/28/2026,OFFICE DEPOT 1234,-1089.40", "03/20/2026,SHELL OIL,-42.15", "03/22/2026,CAFE,-12.00"].join("\n");
  await run(bookkeeper, (ctx) => review.importStatement(ctx, { accountId: card.id, content: csv, fileName: "card.csv", applyRules: false }));
  const lineOf = async (desc: string) => {
    const [l] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.accountId, card.id), eq(bankStatementLines.description, desc)));
    return l;
  };
  await check("suggestions: the waiting bank line, the vendor, the card's account", async () => {
    const a = await run(viewer, (ctx) => files.getAttachment(ctx, { id: depotId }));
    const s = a.suggestions!;
    assertEq(s.vendor?.id, officeDepot.id, "vendor");
    assertEq(s.bankAccount?.id, card.id, "account by last 4");
    assertEq(s.matches[0]?.kind, "statement_line", "bank line first");
    assertEq(s.matches[0]?.id, (await lineOf("OFFICE DEPOT 1234")).id, "the right line");
  });
  await check("suggestions: a posted expense and a bill with the same total; the vendor's usual category", async () => {
    await run(bookkeeper, (ctx) =>
      txns.createExpense(ctx, { txnDate: "2026-03-01", bankAccountId: checking.id, vendorId: officeDepot.id, lines: [{ accountId: supplies.id, amount: "15" }], post: true })
    );
    const exp = await run(bookkeeper, (ctx) =>
      txns.createExpense(ctx, { txnDate: "2026-03-26", bankAccountId: checking.id, payeeName: "Depot", lines: [{ accountId: supplies.id, amount: "1089.40" }], post: true })
    );
    const bill = await run(bookkeeper, (ctx) => bills.createBill(ctx, { vendorId: officeDepot.id, billDate: "2026-03-30", lines: [{ accountId: supplies.id, amount: "1089.40" }] }));
    const s = (await run(viewer, (ctx) => files.getAttachment(ctx, { id: depotId }))).suggestions!;
    assert(s.matches.some((m) => m.kind === "bank_transaction" && m.id === exp.id), "expense");
    assert(s.matches.some((m) => m.kind === "bill" && m.id === bill.id), "bill");
    assertEq(s.categoryAccount?.id, supplies.id, "usual category");
  });

  section("Receipts follow a bank line");
  await check("a receipt on a bank line moves to the transaction it becomes, split across categories", async () => {
    const line = await lineOf("OFFICE DEPOT 1234");
    await run(bookkeeper, (ctx) => files.linkAttachment(ctx, { id: depotId, entityType: "statement_line", entityId: line.id }));
    const listed = await run(viewer, (ctx) => review.listStatementLines(ctx, { accountId: card.id }));
    assertEq(listed.data.find((l) => l.id === line.id)?.attachments[0]?.id, depotId, "paperclip on the line");
    await expectError(
      () => run(bookkeeper, (ctx) => review.addStatementLine(ctx, { id: line.id, splits: [{ accountId: supplies.id, amount: "1000" }, { accountId: fees.id, amount: "80" }] })),
      "invalid_input"
    );
    await expectError(
      () =>
        run(bookkeeper, (ctx) =>
          review.addStatementLine(ctx, { id: line.id, categoryAccountId: supplies.id, splits: [{ accountId: supplies.id, amount: "1000" }, { accountId: fees.id, amount: "89.40" }] })
        ),
      "invalid_input"
    );
    const added = await run(bookkeeper, (ctx) =>
      review.addStatementLine(ctx, {
        id: line.id,
        vendorId: officeDepot.id,
        splits: [
          { accountId: supplies.id, amount: "1000", description: "Printer" },
          { accountId: fees.id, amount: "89.40", description: "Tax" },
        ],
      })
    );
    assertEq(added.transaction.status, "posted", "posted");
    const tl = await db.select().from(bankTransactionLines).where(eq(bankTransactionLines.transactionId, added.transaction.id));
    assertEq(tl.length, 2, "two lines");
    assertEq(tl.map((l) => l.amount).sort().join(","), "1000.0000,89.4000", "split amounts");
    const on = await run(viewer, (ctx) => files.attachmentsFor(ctx, "bank_transaction", added.transaction.id));
    assertEq(on[0]?.id, depotId, "receipt moved to the transaction");
  });
  await check("undoing the line brings the receipt back to it; excluding sends it to the inbox", async () => {
    const line = await lineOf("OFFICE DEPOT 1234");
    await run(owner, (ctx) => review.undoStatementLine(ctx, { id: line.id }));
    assertEq((await run(viewer, (ctx) => files.attachmentsFor(ctx, "statement_line", line.id)))[0]?.id, depotId, "back on the line");
    await run(bookkeeper, (ctx) => review.excludeStatementLine(ctx, { id: line.id }));
    const a = await run(viewer, (ctx) => files.getAttachment(ctx, { id: depotId }));
    assertEq(a.entityType, null, "in the inbox");
  });
  await check("matching a line to what's already in the books moves its receipt to that document", async () => {
    const shell = await lineOf("SHELL OIL");
    const exp = await run(bookkeeper, (ctx) =>
      txns.createExpense(ctx, { txnDate: "2026-03-19", bankAccountId: card.id, payeeName: "Shell", lines: [{ accountId: meals.id, amount: "42.15" }], post: true })
    );
    const receipt = await upload(bookkeeper, png(), { read: false, entityType: "statement_line", entityId: shell.id });
    const rows = await run(viewer, (ctx) => review.listStatementLines(ctx, { accountId: card.id }));
    const glLineId = rows.data.find((l) => l.id === shell.id)!.suggestedMatches[0].glLineId;
    const [gl] = await db.select().from(glLines).where(eq(glLines.id, glLineId));
    assert(gl, "ledger line");
    await run(bookkeeper, (ctx) => review.matchStatementLine(ctx, { id: shell.id, glLineIds: [glLineId] }));
    const moved = await run(viewer, (ctx) => files.getAttachment(ctx, { id: receipt.id }));
    assertEq(moved.entityType, "bank_transaction", "type");
    assertEq(moved.entityId, exp.id, "the matched expense");
  });

  section("A new expense from a receipt");
  await check("records the expense as read, attaches the receipt, and won't do it twice", async () => {
    const r = jpeg();
    fake.set(r, { documentType: "receipt", vendorName: "Blue Bottle", date: "2026-03-22", total: "12.00", paymentMethod: "card", description: "Coffee" });
    const a = await upload(agent, r);
    await expectError(() => run(viewer, (ctx) => files.createExpenseFromReceipt(ctx, { id: a.id, bankAccountId: card.id, categoryAccountId: meals.id })), "forbidden");
    const out = await run(agent, (ctx) => files.createExpenseFromReceipt(ctx, { id: a.id, bankAccountId: card.id, categoryAccountId: meals.id, post: true }));
    assertEq(out.transaction.txnDate, "2026-03-22", "date as read");
    assertEq(out.transaction.totalAmount, "12.0000", "total as read");
    assertEq(out.transaction.payee, "Blue Bottle", "payee");
    assertEq(out.attachment.entityType, "bank_transaction", "attached");
    await expectError(() => run(agent, (ctx) => files.createExpenseFromReceipt(ctx, { id: a.id, bankAccountId: card.id, categoryAccountId: meals.id })), "invalid_state");
  });
  await check("a check receipt becomes a check; without a date or total it asks for them", async () => {
    const r = pdf();
    fake.set(r, { documentType: "receipt", vendorName: "Landlord", date: "2026-03-01", total: "2000.00", paymentMethod: "check", reference: "1050" });
    const a = await upload(bookkeeper, r);
    const out = await run(bookkeeper, (ctx) => files.createExpenseFromReceipt(ctx, { id: a.id, bankAccountId: checking.id, categoryAccountId: rent.id }));
    assertEq(out.transaction.type, "check", "check");
    const blank = await upload(bookkeeper, png(), { read: false });
    await expectError(() => run(bookkeeper, (ctx) => files.createExpenseFromReceipt(ctx, { id: blank.id, bankAccountId: checking.id, categoryAccountId: rent.id })), "invalid_input");
    const given = await run(bookkeeper, (ctx) =>
      files.createExpenseFromReceipt(ctx, { id: blank.id, bankAccountId: checking.id, categoryAccountId: rent.id, txnDate: "2026-03-05", amount: "7.50", payeeName: "Parking" })
    );
    assertEq(given.transaction.totalAmount, "7.5000", "given amount");
  });

  section("Files on documents");
  await check("attach to a bill, a journal entry, a vendor; read them back; counts for lists", async () => {
    const bill = await run(bookkeeper, (ctx) => bills.createBill(ctx, { vendorId: officeDepot.id, billDate: "2026-03-02", lines: [{ accountId: supplies.id, amount: "5" }] }));
    const je = await run(owner, (ctx) =>
      journals.createJournalEntry(ctx, { date: "2026-03-03", description: "Accrual", lines: [{ accountId: rent.id, debit: "5" }, { accountId: checking.id, credit: "5" }] })
    );
    const bytes = pdf();
    const onBill = await upload(bookkeeper, bytes, { entityType: "bill", entityId: bill.id, fileName: "bill.pdf" });
    await upload(bookkeeper, png(), { entityType: "journal", entityId: je.id });
    assertEq(onBill.entityHref, `/ap/bills/${bill.id}`, "link to the bill");
    const listed = await run(viewer, (ctx) => files.listAttachments(ctx, { entityType: "bill", entityId: bill.id }));
    assertEq(listed.data.length, 1, "one on the bill");
    const counts = await run(viewer, (ctx) => files.attachmentCounts(ctx, "bill", [bill.id]));
    assertEq(counts.get(bill.id), 1, "count");
    const dl = await run(viewer, (ctx) => files.downloadAttachment(ctx, { id: onBill.id }));
    assertEq(dl.contentBase64, b64(bytes), "same bytes");
    assertEq(dl.contentType, "application/pdf", "type");
    const inbox = await run(viewer, (ctx) => files.listAttachments(ctx, { inbox: true, limit: 200 }));
    assert(inbox.data.every((a) => a.entityType === null), "inbox only has loose files");
  });
  await check("a document of another company can't be named", async () => {
    const theirVendor = await other.run(other.as("owner"), (ctx) => parties.createVendor(ctx, { name: "Theirs" }));
    await expectError(() => upload(bookkeeper, png(), { entityType: "vendor", entityId: theirVendor.id }), "not_found");
    await expectError(() => upload(bookkeeper, png(), { entityType: "vendor" }), "invalid_input");
    const a = await upload(bookkeeper, png(), { read: false });
    await expectError(() => run(bookkeeper, (ctx) => files.linkAttachment(ctx, { id: a.id, entityType: "vendor", entityId: theirVendor.id })), "not_found");
  });
  await check("the database refuses a file pointing at another company's document, or half a link", async () => {
    const theirVendor = await other.run(other.as("owner"), (ctx) => parties.createVendor(ctx, { name: "Theirs too" }));
    const a = await upload(bookkeeper, png(), { read: false });
    for (const values of [{ entityType: "vendor" as const, entityId: theirVendor.id }, { entityType: "vendor" as const, entityId: null }]) {
      let refused = false;
      try {
        await db.update(attachments).set(values).where(eq(attachments.id, a.id));
      } catch {
        refused = true;
      }
      assert(refused, `refused ${JSON.stringify(values)}`);
    }
  });

  section("Deleting, upkeep");
  await check("agents delete only their own uploads; deleting removes the file and keeps the audit", async () => {
    const mine = await upload(agent, png(), { read: false });
    const theirs = await upload(bookkeeper, png(), { read: false });
    await expectError(() => run(agent, (ctx) => files.deleteAttachment(ctx, { id: theirs.id })), "forbidden");
    await expectError(() => run(viewer, (ctx) => files.deleteAttachment(ctx, { id: theirs.id })), "forbidden");
    const count = memoryFileCount();
    await run(agent, (ctx) => files.deleteAttachment(ctx, { id: mine.id }));
    await run(bookkeeper, (ctx) => files.deleteAttachment(ctx, { id: theirs.id }));
    assertEq(memoryFileCount(), count - 2, "files gone from storage");
    await expectError(() => run(viewer, (ctx) => files.getAttachment(ctx, { id: mine.id })), "not_found");
    assertEq(await audits("attachment.deleted"), 2, "audited");
  });
  await check("the daily upkeep returns files of deleted drafts to the inbox and reads receipts left pending", async () => {
    const draft = await run(bookkeeper, (ctx) => bills.createBill(ctx, { vendorId: officeDepot.id, billDate: "2026-03-04", lines: [{ accountId: supplies.id, amount: "3" }] }));
    const f = await upload(bookkeeper, png(), { entityType: "bill", entityId: draft.id });
    await run(bookkeeper, (ctx) => bills.deleteDraftBill(ctx, { id: draft.id }));
    const stuck = png();
    fake.set(stuck, { documentType: "receipt", vendorName: "Late Read", total: "9.99", date: "2026-03-09" });
    const p = await upload(bookkeeper, stuck, { read: false });
    assertEq(p.readStatus, "pending", "pending");
    await db.update(attachments).set({ createdAt: sql`now() - interval '1 hour'` }).where(eq(attachments.id, p.id));
    const r = await files.runAttachmentUpkeepForOrg(t.org.id);
    assertEq(r.returned, 1, "returned");
    assertEq(r.read, 1, "read");
    assertEq((await run(viewer, (ctx) => files.getAttachment(ctx, { id: f.id }))).entityType, null, "back in the inbox");
    assertEq((await run(viewer, (ctx) => files.getAttachment(ctx, { id: p.id }))).extracted?.vendorName, "Late Read", "read by upkeep");
  });

  section("Another company, and the API");
  await check("another company sees and touches none of these files", async () => {
    const oa = other.as("owner");
    assertEq((await other.run(oa, (ctx) => files.listAttachments(ctx, {}))).data.length, 0, "none listed");
    await expectError(() => other.run(oa, (ctx) => files.getAttachment(ctx, { id: depotId })), "not_found");
    await expectError(() => other.run(oa, (ctx) => files.downloadAttachment(ctx, { id: depotId })), "not_found");
    await expectError(() => other.run(oa, (ctx) => files.linkAttachment(ctx, { id: depotId, entityType: null, entityId: null })), "not_found");
    await expectError(() => other.run(oa, (ctx) => files.readAttachment(ctx, { id: depotId })), "not_found");
    await expectError(() => other.run(oa, (ctx) => files.deleteAttachment(ctx, { id: depotId })), "not_found");
  });
  await check("the operations are in the API and MCP", async () => {
    const names = new Set(OPERATIONS.map((o) => o.name));
    for (const n of ["upload_attachment", "list_attachments", "get_attachment", "download_attachment", "read_attachment", "link_attachment", "create_expense_from_receipt", "delete_attachment"]) {
      assert(names.has(n), n);
    }
    const add = OPERATIONS.find((o) => o.name === "add_bank_line")!;
    assert(add.description.includes("splits"), "add_bank_line mentions splits");
  });
  await check("runs as the system for upkeep without a person", async () => {
    const v = await runAs({ ...t.as("owner"), kind: "system", userId: null }, (ctx) => files.listAttachments(ctx, { limit: 1 }));
    assert(v.data.length === 1, "lists");
  });

  await fake.close();
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
