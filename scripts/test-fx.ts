/**
 * End-to-end verification of the FX revaluation engine. Posts a foreign-
 * currency JE, adds a later spot rate, runs revaluation, and verifies the
 * posted adjustment JE has the correct per-account amounts and that
 * auto-reversal is scheduled.
 *
 * Note on math: our one-currency-per-journal model guarantees every journal
 * balances in its own currency, so per-currency subsets of the ledger also
 * balance. Revaluation produces non-zero per-account adjustments but
 * net-zero across the whole ledger. Realized FX gain/loss arises from
 * AR/AP payment flows (Tier 2+), not from GL-level revaluation.
 *
 *   npx tsx scripts/test-fx.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  accounts,
  exchangeRates,
  glJournals,
  glLines,
  memberships,
  organizations,
  profiles,
  sourceCodes,
} from "../src/lib/db/schema";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { createAndPostJournal } from "../src/lib/gl/posting";
import {
  computeFxAdjustments,
  runFxRevaluation,
} from "../src/lib/gl/fx-revaluation";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";
import { money } from "../src/lib/money";

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
  const testSlug = `fx-test-${Date.now()}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "fx-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in first.");

  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "FX Test", slug: testSlug, baseCurrency: "USD" })
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
      revenue: byCode.get("4000")!,
      fxGain: byCode.get("4930")!,
      fxLoss: byCode.get("7400")!,
      sourceCodeId: gjSrc.id,
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  console.log("Setup");
  await check("add EUR→USD spot rate 1.0800 effective 2026-01-01", async () => {
    await db.insert(exchangeRates).values({
      organizationId: fixtures.org.id,
      fromCurrency: "EUR",
      toCurrency: "USD",
      rateType: "spot",
      effectiveDate: "2026-01-01",
      rate: "1.08",
      inverseRate: (1 / 1.08).toFixed(10),
    });
  });

  await check("post EUR JE at rate 1.08 (Dr Cash 1000 EUR / Cr Rev 1000 EUR)", async () => {
    const r = await createAndPostJournal({
      organizationId: fixtures.org.id,
      actorId: null,
      journalDate: "2026-02-15",
      sourceCodeId: fixtures.sourceCodeId,
      source: "manual",
      description: "EUR sale",
      currency: "EUR",
      exchangeRate: "1.08",
      lines: [
        { accountId: fixtures.cash.id, debit: "1000.00" },
        { accountId: fixtures.revenue.id, credit: "1000.00" },
      ],
    });
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
  });

  console.log("\nRate update + preview");
  await check("add EUR→USD spot rate 1.1500 effective 2026-03-31", async () => {
    await db.insert(exchangeRates).values({
      organizationId: fixtures.org.id,
      fromCurrency: "EUR",
      toCurrency: "USD",
      rateType: "spot",
      effectiveDate: "2026-03-31",
      rate: "1.15",
      inverseRate: (1 / 1.15).toFixed(10),
    });
  });

  await check("preview adjustments: Cash +70, Revenue -70, net 0", async () => {
    const s = await computeFxAdjustments(fixtures.org.id, "2026-03-31");
    if (s.missingRates.length > 0)
      throw new Error(`missing rates: ${JSON.stringify(s.missingRates)}`);
    if (s.adjustments.length !== 2)
      throw new Error(`expected 2 adjustments, got ${s.adjustments.length}`);

    const cash = s.adjustments.find((a) => a.accountCode === "1010");
    const rev = s.adjustments.find((a) => a.accountCode === "4000");
    if (!cash || !rev) throw new Error("cash/revenue adjustment missing");
    if (!cash.adjustment.equals(70))
      throw new Error(`cash adj=${cash.adjustment} ≠ 70`);
    if (!rev.adjustment.equals(-70))
      throw new Error(`revenue adj=${rev.adjustment} ≠ -70`);
    if (!s.netAdjustment.isZero())
      throw new Error(`net=${s.netAdjustment} ≠ 0 (expected for balanced JE)`);
  });

  console.log("\nRun revaluation");
  let revalJournalId: string | null = null;
  await check("post reval JE with auto-reverse on 2026-04-01", async () => {
    const r = await runFxRevaluation({
      organizationId: fixtures.org.id,
      actorId: null,
      asOfDate: "2026-03-31",
      fxGainAccountId: fixtures.fxGain.id,
      fxLossAccountId: fixtures.fxLoss.id,
      sourceCodeId: fixtures.sourceCodeId,
      autoReverseDate: "2026-04-01",
    });
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    revalJournalId = r.journalId;
  });

  await check("posted JE: 2 lines, balanced, base currency", async () => {
    const [j] = await db
      .select()
      .from(glJournals)
      .where(eq(glJournals.id, revalJournalId!));
    if (j.currency !== "USD")
      throw new Error(`expected USD, got ${j.currency}`);
    if (j.status !== "posted") throw new Error(`status=${j.status} ≠ posted`);
    if (j.autoReverseDate !== "2026-04-01")
      throw new Error(`auto_reverse=${j.autoReverseDate}`);

    const lines = await db
      .select()
      .from(glLines)
      .where(eq(glLines.journalId, revalJournalId!));
    if (lines.length !== 2)
      throw new Error(`expected 2 lines (no gain/loss since net=0), got ${lines.length}`);
    const totalDr = lines.reduce((a, l) => a.plus(money(l.debitLocal)), money(0));
    const totalCr = lines.reduce((a, l) => a.plus(money(l.creditLocal)), money(0));
    if (!totalDr.equals(totalCr)) throw new Error("unbalanced reval JE");
    if (!totalDr.equals(70))
      throw new Error(`reval JE total=${totalDr} ≠ 70`);
  });

  console.log("\nError paths");
  await check("preview with missing rate returns missing_rates", async () => {
    // Post a GBP journal (no GBP rate exists) — preview should surface it
    await createAndPostJournal({
      organizationId: fixtures.org.id,
      actorId: null,
      journalDate: "2026-02-20",
      sourceCodeId: fixtures.sourceCodeId,
      source: "manual",
      description: "GBP sale",
      currency: "GBP",
      exchangeRate: "1.25",
      lines: [
        { accountId: fixtures.cash.id, debit: "500.00" },
        { accountId: fixtures.revenue.id, credit: "500.00" },
      ],
    });
    const s = await computeFxAdjustments(fixtures.org.id, "2026-04-15");
    const hasGbp = s.missingRates.some(
      (m) => m.fromCurrency === "GBP" && m.toCurrency === "USD"
    );
    if (!hasGbp) throw new Error("expected GBP→USD missing rate");
  });

  await check("run with missing rate rejects", async () => {
    const r = await runFxRevaluation({
      organizationId: fixtures.org.id,
      actorId: null,
      asOfDate: "2026-04-15",
      fxGainAccountId: fixtures.fxGain.id,
      fxLossAccountId: fixtures.fxLoss.id,
      sourceCodeId: fixtures.sourceCodeId,
    });
    if (r.ok) throw new Error("expected failure");
    if (r.code !== "missing_rates")
      throw new Error(`expected missing_rates, got ${r.code}`);
  });

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, fixtures.org.id));
  });

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
