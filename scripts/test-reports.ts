/**
 * End-to-end verification of the reports engine. Posts a realistic scenario
 * against a fresh test org, then validates:
 *   - Trial Balance: sum(debit) = sum(credit)
 *   - Balance Sheet: Assets = Liabilities + Equity
 *   - Income Statement: Revenue − COGS − OpEx = Net Income
 *   - GL Detail for Cash: running balance matches hand-calculation
 *
 *   npx tsx scripts/test-reports.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../src/lib/db/client";
import {
  accounts,
  memberships,
  organizations,
  profiles,
  sourceCodes,
} from "../src/lib/db/schema";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { createAndPostJournal } from "../src/lib/gl/posting";
import {
  getBalanceSheet,
  getGlDetail,
  getIncomeStatement,
  getTrialBalance,
} from "../src/lib/gl/reports";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";
import { money, sumMoney } from "../src/lib/money";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ${PASS} ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ${FAIL} ${name}`);
    console.log(`     ${(e as Error).message}`);
  }
}

async function main() {
  const testSlug = `reports-test-${Date.now()}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "reports-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "Reports Test", slug: testSlug, baseCurrency: "USD" })
      .returning();
    await tx.insert(memberships).values({
      organizationId: org.id,
      userId: actor.id,
      role: "owner",
    });
    await seedOrganizationDefaults(tx, org.id, { includeContractorCoa: true });
    await generateFiscalYear(tx, {
      organizationId: org.id,
      startDate: "2026-01-01",
      yearLabel: "FY2026",
    });

    const acctRows = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, org.id));
    const byCode = new Map(acctRows.map((a) => [a.code, a]));

    const [gjSrc] = await tx
      .select()
      .from(sourceCodes)
      .where(
        and(eq(sourceCodes.organizationId, org.id), eq(sourceCodes.code, "GJ"))
      );

    return {
      org,
      cash: byCode.get("1010")!,
      equity: byCode.get("3000")!,
      revenue: byCode.get("4000")!,
      cogsMaterials: byCode.get("5100")!,
      rent: byCode.get("6600")!,
      sourceCodeId: gjSrc.id,
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  // Build a realistic mini scenario. Expected end state:
  //   Cash: +100k (capital) +50k (rev) -30k (cogs) -5k (rent) = 115k
  //   Equity: 100k
  //   Revenue: 50k
  //   COGS: 30k
  //   Rent Expense: 5k
  //   Net Income: 50k - 30k - 5k = 15k
  //   Balance Sheet: Assets 115k = Liabilities 0 + Equity 100k + Net Income 15k

  async function post(args: {
    date: string;
    desc: string;
    lines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string }>;
  }) {
    const r = await createAndPostJournal({
      organizationId: fixtures.org.id,
      actorId: null,
      journalDate: args.date,
      sourceCodeId: fixtures.sourceCodeId,
      source: "manual",
      description: args.desc,
      lines: args.lines,
    });
    if (!r.ok) throw new Error(`post failed: ${r.code} ${r.error}`);
    return r.journalId;
  }

  console.log("Posting scenario");
  await check("opening capital — Dr Cash 100k / Cr Equity 100k", async () => {
    await post({
      date: "2026-01-05",
      desc: "Opening capital contribution",
      lines: [
        { accountId: fixtures.cash.id, debit: "100000.00" },
        { accountId: fixtures.equity.id, credit: "100000.00" },
      ],
    });
  });
  await check("revenue — Dr Cash 50k / Cr Revenue 50k", async () => {
    await post({
      date: "2026-02-10",
      desc: "Contract revenue",
      lines: [
        { accountId: fixtures.cash.id, debit: "50000.00" },
        { accountId: fixtures.revenue.id, credit: "50000.00" },
      ],
    });
  });
  await check("cogs — Dr COGS 30k / Cr Cash 30k", async () => {
    await post({
      date: "2026-02-15",
      desc: "Materials cost",
      lines: [
        { accountId: fixtures.cogsMaterials.id, debit: "30000.00" },
        { accountId: fixtures.cash.id, credit: "30000.00" },
      ],
    });
  });
  await check("rent — Dr Rent 5k / Cr Cash 5k", async () => {
    await post({
      date: "2026-03-01",
      desc: "Rent — March",
      lines: [
        { accountId: fixtures.rent.id, debit: "5000.00" },
        { accountId: fixtures.cash.id, credit: "5000.00" },
      ],
    });
  });

  console.log("\nTrial Balance");
  await check("TB totals balance (Σ debit = Σ credit)", async () => {
    const rows = await getTrialBalance(fixtures.org.id, {
      asOfDate: "2026-12-31",
    });
    const totalDr = sumMoney(rows.map((r) => r.totalDebit));
    const totalCr = sumMoney(rows.map((r) => r.totalCredit));
    if (!totalDr.equals(totalCr)) {
      throw new Error(`Σ Dr=${totalDr} ≠ Σ Cr=${totalCr}`);
    }
  });
  await check("TB has the 5 accounts we touched", async () => {
    const rows = await getTrialBalance(fixtures.org.id, {
      asOfDate: "2026-12-31",
    });
    const codes = rows.map((r) => r.code).sort();
    const expected = ["1010", "3000", "4000", "5100", "6600"].sort();
    for (const c of expected) {
      if (!codes.includes(c))
        throw new Error(`missing ${c} in TB; got [${codes.join(", ")}]`);
    }
  });
  await check("cash balance = 115,000 (debit)", async () => {
    const rows = await getTrialBalance(fixtures.org.id, {
      asOfDate: "2026-12-31",
    });
    const cash = rows.find((r) => r.code === "1010");
    if (!cash) throw new Error("cash missing");
    if (!cash.netDebit.equals(115000))
      throw new Error(`cash netDebit=${cash.netDebit} ≠ 115000`);
  });

  console.log("\nBalance Sheet");
  await check("Assets = Liabilities + Equity (with current-year earnings)", async () => {
    const bs = await getBalanceSheet(fixtures.org.id, "2026-12-31");
    if (!bs.outOfBalance.isZero()) {
      throw new Error(
        `Out of balance by ${bs.outOfBalance}. Assets=${bs.assets.total}, L=${bs.liabilities.total}, E=${bs.equity.total}`
      );
    }
  });
  await check("total assets = 115,000 (just cash)", async () => {
    const bs = await getBalanceSheet(fixtures.org.id, "2026-12-31");
    if (!bs.assets.total.equals(115000))
      throw new Error(`assets=${bs.assets.total} ≠ 115000`);
  });
  await check(
    "equity = 100,000 + net income 15,000 = 115,000",
    async () => {
      const bs = await getBalanceSheet(fixtures.org.id, "2026-12-31");
      if (!bs.equity.total.equals(115000))
        throw new Error(`equity=${bs.equity.total} ≠ 115000`);
    }
  );

  console.log("\nIncome Statement");
  await check("revenue 50k, COGS 30k, gross profit 20k", async () => {
    const is = await getIncomeStatement(fixtures.org.id, {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    if (!is.revenue.total.equals(50000))
      throw new Error(`revenue=${is.revenue.total} ≠ 50000`);
    if (!is.cogs.total.equals(30000))
      throw new Error(`cogs=${is.cogs.total} ≠ 30000`);
    if (!is.grossProfit.equals(20000))
      throw new Error(`GP=${is.grossProfit} ≠ 20000`);
  });
  await check("opex 5k, operating income 15k", async () => {
    const is = await getIncomeStatement(fixtures.org.id, {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    if (!is.operatingExpenses.total.equals(5000))
      throw new Error(`opex=${is.operatingExpenses.total} ≠ 5000`);
    if (!is.operatingIncome.equals(15000))
      throw new Error(`OI=${is.operatingIncome} ≠ 15000`);
  });
  await check("net income = 15,000", async () => {
    const is = await getIncomeStatement(fixtures.org.id, {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    if (!is.netIncome.equals(15000))
      throw new Error(`NI=${is.netIncome} ≠ 15000`);
  });

  console.log("\nGL Detail — Cash");
  await check("4 postings to Cash, running balance ends at 115,000", async () => {
    const { rows } = await getGlDetail(fixtures.org.id, {
      accountId: fixtures.cash.id,
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    if (rows.length !== 4)
      throw new Error(`expected 4 lines, got ${rows.length}`);
    const last = rows[rows.length - 1];
    if (!last.runningBalance.equals(115000))
      throw new Error(`final balance=${last.runningBalance} ≠ 115000`);
    // Sanity: each running balance increments correctly
    const expected = [new Decimal(100000), new Decimal(150000), new Decimal(120000), new Decimal(115000)];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].runningBalance.equals(expected[i])) {
        throw new Error(
          `row ${i} balance=${rows[i].runningBalance} ≠ ${expected[i]}`
        );
      }
    }
  });

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, fixtures.org.id));
  });
  void money;

  console.log(
    `\n${failed === 0 ? PASS : FAIL} ${
      failed === 0 ? "all checks passed" : `${failed} check(s) failed`
    }\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
