/**
 * End-to-end: 1099 tracking. Accounts mapped to boxes (seeded defaults and
 * by hand), payments counted by payment date (bill payments spread over the
 * bill's lines, banking expenses and checks to the vendor), card payments
 * and voided payments left out, thresholds by tax year and the $10
 * royalties rule, filing issues, masked TINs, the audited CSV export, and
 * the role rules.
 *
 *   npx tsx scripts/test-1099.ts
 */
import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, vendors } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as billPayments from "../src/lib/ap/bill-payments";
import * as bills from "../src/lib/ap/bills";
import * as f1099 from "../src/lib/ap/form-1099";
import * as txns from "../src/lib/banking/transactions";
import { money } from "../src/lib/money";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

async function main() {
  const t = await createTestOrg("f1099-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const accountant = t.as("accountant");
  const bookkeeper = t.as("bookkeeper");
  const viewer = t.as("viewer");
  const run = <T,>(actor: Actor, fn: Parameters<typeof t.run<T>>[1]) => t.run(actor, fn);
  const fixed = (v: string | undefined) => money(v ?? 0).toFixed(2);

  const checking = account(t, "1010");
  const card = account(t, "2100");
  const contractors = account(t, "6150");
  const dues = account(t, "6200");
  const software = account(t, "6250");
  const rent = account(t, "6600");

  const mk = async (code: string, name: string, extra: Partial<typeof vendors.$inferInsert> = {}) =>
    (await db.insert(vendors).values({ organizationId: t.org.id, code, name, ...extra }).returning())[0];
  const ace = await mk("V-1", "Ace Contracting", {
    is1099Vendor: true,
    tin: "12-3456789",
    w9OnFile: true,
    addresses: [{ type: "mailing", street1: "5 Hammer St", city: "Mesa", state: "AZ", zip: "85201" }],
  });
  const bob = await mk("V-2", "Bob Freelance", { is1099Vendor: true });
  const notMarked = await mk("V-3", "Unmarked Pro");
  const author = await mk("V-4", "Author Royalties", { is1099Vendor: true, tin: "987654321", w9OnFile: true, addresses: [{ type: "mailing", street1: "1 Pen Ln", city: "Austin", state: "TX", zip: "78701" }] });
  const small = await mk("V-5", "Small Jobs", { is1099Vendor: true, tin: "111223333", w9OnFile: true, addresses: [{ type: "mailing", street1: "2 Elm", city: "Reno", state: "NV", zip: "89501" }] });

  const postBill = (vendorId: string, lines: Array<{ accountId: string; amount: string }>) =>
    run(owner, async (ctx) => {
      const b = await bills.createBill(ctx, { vendorId, billDate: "2026-02-01", lines, submit: true });
      await bills.approveBill(ctx, { id: b.id });
      return bills.postBill(ctx, { id: b.id });
    });
  const pay = (vendorId: string, billId: string, amount: string, opts: { date?: string; method?: "check" | "credit_card"; bank?: string } = {}) =>
    run(owner, (ctx) =>
      billPayments.createBillPayment(ctx, {
        vendorId,
        paymentDate: opts.date ?? "2026-03-01",
        method: opts.method ?? "check",
        reference: String(Math.floor(Math.random() * 1e6)),
        bankAccountId: opts.bank ?? checking.id,
        applications: [{ billId, amount }],
        post: true,
      })
    );
  const expense = (vendorId: string, accountId: string, amount: string, opts: { bank?: string; method?: "check" | "credit_card" } = {}) =>
    run(owner, (ctx) =>
      txns.createExpense(ctx, {
        type: "expense",
        txnDate: "2026-04-01",
        bankAccountId: opts.bank ?? checking.id,
        vendorId,
        method: opts.method ?? "ach",
        lines: [{ accountId, amount }],
        post: true,
      })
    );
  const report = (input: Parameters<typeof f1099.form1099Report>[1] = {}) => run(viewer, (ctx) => f1099.form1099Report(ctx, { year: 2026, ...input }));
  const row = async (vendorId: string, input: Parameters<typeof f1099.form1099Report>[1] = {}) =>
    (await report(input)).vendors.find((v) => v.vendorId === vendorId);

  section("Mapping");
  await check("new companies start with contractors and professional fees on NEC 1, rent on MISC 1", async () => {
    assertEq(contractors.form1099Box, "nec_1", "6150");
    assertEq(account(t, "6350").form1099Box, "nec_1", "6350");
    assertEq(rent.form1099Box, "misc_1", "6600");
    assertEq(dues.form1099Box, null, "6200 not reported");
  });
  await check("an accountant maps an account; bookkeepers can't; balance sheet accounts can't be mapped", async () => {
    const r = await run(accountant, (ctx) => f1099.setAccount1099Box(ctx, { id: software.id, box: "misc_2" }));
    assertEq(r.box, "misc_2", "mapped");
    await expectError(() => run(bookkeeper, (ctx) => f1099.setAccount1099Box(ctx, { id: dues.id, box: "nec_1" })), "forbidden");
    await expectError(() => run(accountant, (ctx) => f1099.setAccount1099Box(ctx, { id: checking.id, box: "nec_1" })), "invalid_input");
  });

  section("What counts");
  await check("bill payments spread over the bill's lines: half of a 3000 + 1000 bill paid = 1500 NEC", async () => {
    const b = await postBill(ace.id, [
      { accountId: contractors.id, amount: "3000" },
      { accountId: dues.id, amount: "1000" },
    ]);
    await pay(ace.id, b.id, "2000");
    const r = await row(ace.id);
    assertEq(fixed(r?.boxes.nec_1), "1500.00", "NEC");
    assertEq(fixed(r?.total), "1500.00", "unmapped dues don't count");
    await pay(ace.id, b.id, "2000", { date: "2026-05-01" });
    assertEq(fixed((await row(ace.id))?.boxes.nec_1), "3000.00", "second half");
  });
  await check("card payments don't count: by card method or from a card account", async () => {
    const b = await postBill(ace.id, [{ accountId: contractors.id, amount: "700" }]);
    await pay(ace.id, b.id, "700", { method: "credit_card", bank: card.id });
    await expense(ace.id, contractors.id, "400", { bank: card.id, method: "credit_card" });
    assertEq(fixed((await row(ace.id))?.boxes.nec_1), "3000.00", "unchanged");
  });
  await check("banking expenses to the vendor count; voided ones don't", async () => {
    await expense(ace.id, rent.id, "2500");
    const voided = await expense(ace.id, rent.id, "999");
    await run(owner, (ctx) => txns.voidBankTransaction(ctx, { id: voided.id, reason: "duplicate" }));
    const r = await row(ace.id);
    assertEq(fixed(r?.boxes.misc_1), "2500.00", "MISC 1 rent");
    assertEq(fixed(r?.total), "5500.00", "total");
    assert(r?.reportable, "reportable");
    assertEq(r?.tinLast4, "6789", "TIN masked to last 4");
    assertEq(r?.issues.length, 0, "nothing to fix");
  });
  await check("payments in another year don't count", async () => {
    // FY2026 periods only; a 2026-12-31 payment is the year's edge.
    const b = await postBill(ace.id, [{ accountId: contractors.id, amount: "100" }]);
    await pay(ace.id, b.id, "100", { date: "2026-12-31" });
    assertEq(fixed((await row(ace.id))?.boxes.nec_1), "3100.00", "Dec 31 counts");
    assertEq((await report({ year: 2025 })).vendors.find((v) => v.vendorId === ace.id)?.total ?? "0", "0.0000", "nothing in 2025");
  });

  section("Thresholds and issues");
  await check("2026 threshold is $2,000; $1,500 isn't reportable unless the threshold is lowered", async () => {
    assertEq(f1099.default1099Threshold(2025), "600", "2025");
    assertEq(f1099.default1099Threshold(2026), "2000", "2026");
    await expense(small.id, contractors.id, "1500");
    assertEq((await row(small.id))?.reportable, false, "below $2,000");
    assertEq((await row(small.id, { threshold: "600" }))?.reportable, true, "at $600 it is");
    assert(!(await report({ reportableOnly: true })).vendors.some((v) => v.vendorId === small.id), "left out of reportableOnly");
  });
  await check("royalties report from $10", async () => {
    await expense(author.id, software.id, "15");
    const r = await row(author.id);
    assertEq(fixed(r?.boxes.misc_2), "15.00", "MISC 2");
    assert(r?.reportable, "reportable at $15");
  });
  await check("issues: missing TIN, W-9, address; paid on 1099 accounts but not marked", async () => {
    await expense(bob.id, contractors.id, "2100");
    const b = await row(bob.id);
    assert(b?.reportable, "reportable");
    assert(b?.issues.includes("No valid TIN"), "TIN");
    assert(b?.issues.includes("No W-9 on file"), "W-9");
    assert(b?.issues.includes("No mailing address"), "address");
    await expense(notMarked.id, contractors.id, "5000");
    const n = await row(notMarked.id);
    assertEq(n?.reportable, false, "not marked, not reportable");
    assert(n?.issues.some((i) => i.includes("not marked")), "flagged");
  });

  section("Export");
  await check("the CSV export has full TINs, reportable vendors only, accountant and up, audited", async () => {
    await expectError(() => run(bookkeeper, (ctx) => f1099.form1099Export(ctx, { year: 2026 })), "forbidden");
    const r = await run(accountant, (ctx) => f1099.form1099Export(ctx, { year: 2026 }));
    const a = r.rows.find((x) => x.vendorId === ace.id);
    assertEq(a?.tin, "12-3456789", "full TIN");
    assert(!r.rows.some((x) => x.vendorId === small.id || x.vendorId === notMarked.id), "only reportable");
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, t.org.id), eq(auditLog.event, "reports.1099.exported")));
    assertEq(audits.length, 1, "audited");
  });
  await check("the report itself never carries full TINs", async () => {
    const r = await report();
    assert(!JSON.stringify(r).includes("3456789"), "no full TIN in the report");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
