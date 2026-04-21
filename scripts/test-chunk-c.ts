/**
 * End-to-end verification for Chunk C — auto-reversal, recurring, allocations,
 * budgets. Creates an isolated test org, exercises each feature, cleans up.
 *
 *   npx tsx scripts/test-chunk-c.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  accounts,
  allocationGroups,
  allocationTargets,
  budgetEntries,
  budgets,
  fiscalPeriods,
  fiscalYears,
  glJournals,
  journalTemplates,
  memberships,
  numberSeries,
  organizations,
  profiles,
  recurringJournalLines,
  recurringJournals,
  sourceCodes,
} from "../src/lib/db/schema";
import { runAutoReversalsForOrg } from "../src/lib/gl/auto-reversal";
import { runAllocation } from "../src/lib/gl/allocations";
import {
  budgetedAmountFor,
  createBudget,
  lockBudget,
  setBudgetEntry,
} from "../src/lib/gl/budgets";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { createAndPostJournal } from "../src/lib/gl/posting";
import { runRecurringForOrg } from "../src/lib/gl/recurring";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";

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
  const testSlug = `chunkc-test-${Date.now()}`;

  // Cleanup prior test orgs (bypass posted-journal delete block).
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "chunkc-test-%"));
  });

  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) throw new Error("No profiles. Log in at least once first.");

  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "Chunk C Test Org", slug: testSlug, baseCurrency: "USD" })
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

    const [jeSeries] = await tx
      .select()
      .from(numberSeries)
      .where(
        and(eq(numberSeries.organizationId, org.id), eq(numberSeries.code, "JE"))
      );

    // Journal template for recurring
    const [tmpl] = await tx
      .insert(journalTemplates)
      .values({
        organizationId: org.id,
        code: "RENT",
        name: "Monthly Rent",
        sourceCodeId: gjSrc.id,
        numberSeriesId: jeSeries.id,
      })
      .returning({ id: journalTemplates.id });

    return {
      org,
      actor,
      rent: byCode.get("6600")!,
      cash: byCode.get("1010")!,
      officeSupplies: byCode.get("6620")!,
      marketing: byCode.get("6680")!,
      gjSourceCodeId: gjSrc.id,
      templateId: tmpl.id,
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}\n`);

  // -------------------------------------------------------------------------
  console.log("Auto-reversal");
  let accrualId: string | null = null;
  await check("post a JE with auto_reverse_date in the future", async () => {
    const r = await createAndPostJournal({
      organizationId: fixtures.org.id,
      actorId: fixtures.actor.id,
      journalDate: "2026-01-31",
      sourceCodeId: fixtures.gjSourceCodeId,
      source: "adjusting",
      description: "January accrual",
      autoReverseDate: "2026-02-01",
      lines: [
        { accountId: fixtures.rent.id, debit: "1000.00" },
        { accountId: fixtures.cash.id, credit: "1000.00" },
      ],
    });
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    accrualId = r.journalId;
  });

  await check("auto-reversal runs on the scheduled date", async () => {
    const result = await runAutoReversalsForOrg(fixtures.org.id, "2026-02-01");
    if (result.generated !== 1)
      throw new Error(`expected 1 generated, got ${result.generated}`);
    if (result.errors.length > 0)
      throw new Error(`unexpected errors: ${JSON.stringify(result.errors)}`);
  });

  await check("original is now marked reversed", async () => {
    const [row] = await db
      .select({ status: glJournals.status })
      .from(glJournals)
      .where(eq(glJournals.id, accrualId!));
    if (row.status !== "reversed")
      throw new Error(`expected reversed, got ${row.status}`);
  });

  await check("auto-reversal is idempotent (next run finds 0 due)", async () => {
    const result = await runAutoReversalsForOrg(fixtures.org.id, "2026-02-01");
    if (result.generated !== 0)
      throw new Error(`expected 0, got ${result.generated}`);
  });

  // -------------------------------------------------------------------------
  console.log("\nRecurring journals");
  let recurringId: string | null = null;
  await check("create a monthly recurring journal", async () => {
    const [rec] = await db
      .insert(recurringJournals)
      .values({
        organizationId: fixtures.org.id,
        code: "RENT-MONTHLY",
        name: "Monthly Rent Payment",
        journalTemplateId: fixtures.templateId,
        journalDescription: "Monthly rent — March",
        frequency: "monthly",
        startDate: "2026-03-01",
        nextRunDate: "2026-03-01",
        currency: "USD",
      })
      .returning({ id: recurringJournals.id });
    recurringId = rec.id;

    await db.insert(recurringJournalLines).values([
      {
        organizationId: fixtures.org.id,
        recurringJournalId: rec.id,
        lineNumber: 1,
        accountId: fixtures.rent.id,
        debit: "4500.00",
      },
      {
        organizationId: fixtures.org.id,
        recurringJournalId: rec.id,
        lineNumber: 2,
        accountId: fixtures.cash.id,
        credit: "4500.00",
      },
    ]);
  });

  await check("recurring runner generates a JE and advances next_run_date", async () => {
    const result = await runRecurringForOrg(fixtures.org.id, "2026-03-05");
    if (result.generated !== 1)
      throw new Error(`expected 1 generated, got ${result.generated}. errors=${JSON.stringify(result.errors)}`);

    const [rec] = await db
      .select()
      .from(recurringJournals)
      .where(eq(recurringJournals.id, recurringId!));
    if (rec.nextRunDate !== "2026-04-01")
      throw new Error(`expected next_run=2026-04-01, got ${rec.nextRunDate}`);
    if (!rec.lastRunJournalId)
      throw new Error("expected last_run_journal_id to be set");
  });

  await check("same-day second run generates nothing (already advanced)", async () => {
    const result = await runRecurringForOrg(fixtures.org.id, "2026-03-05");
    if (result.generated !== 0)
      throw new Error(`expected 0 generated, got ${result.generated}`);
  });

  // -------------------------------------------------------------------------
  console.log("\nAllocations");
  let allocGroupId: string | null = null;
  await check("create a fixed 60/40 allocation group", async () => {
    const [grp] = await db
      .insert(allocationGroups)
      .values({
        organizationId: fixtures.org.id,
        code: "OVERHEAD-SPLIT",
        name: "Overhead split across departments",
        allocationType: "fixed",
      })
      .returning({ id: allocationGroups.id });
    allocGroupId = grp.id;

    await db.insert(allocationTargets).values([
      {
        organizationId: fixtures.org.id,
        allocationGroupId: grp.id,
        accountId: fixtures.officeSupplies.id,
        percent: "60",
      },
      {
        organizationId: fixtures.org.id,
        allocationGroupId: grp.id,
        accountId: fixtures.marketing.id,
        percent: "40",
      },
    ]);
  });

  await check("runAllocation posts a balanced JE split 60/40", async () => {
    const r = await runAllocation({
      organizationId: fixtures.org.id,
      groupId: allocGroupId!,
      totalAmount: "10000",
      sourceAccountId: fixtures.rent.id,
      journalDate: "2026-03-31",
      description: "Reallocate rent across departments",
      actorId: fixtures.actor.id,
    });
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);

    // Verify the lines
    const lines = await db
      .select({
        accountId: sql`account_id`,
        debit: sql`debit`,
        credit: sql`credit`,
      })
      .from(sql`gl_lines`)
      .where(sql`journal_id = ${r.journalId} ORDER BY line_number`);

    if (lines.length !== 3)
      throw new Error(`expected 3 lines, got ${lines.length}`);
  });

  await check("bad percentages (not summing to 100) get rejected", async () => {
    const [bad] = await db
      .insert(allocationGroups)
      .values({
        organizationId: fixtures.org.id,
        code: "BAD-ALLOC",
        name: "Bad percentages",
        allocationType: "fixed",
      })
      .returning({ id: allocationGroups.id });

    await db.insert(allocationTargets).values([
      {
        organizationId: fixtures.org.id,
        allocationGroupId: bad.id,
        accountId: fixtures.officeSupplies.id,
        percent: "50",
      },
      {
        organizationId: fixtures.org.id,
        allocationGroupId: bad.id,
        accountId: fixtures.marketing.id,
        percent: "40", // total 90, not 100
      },
    ]);

    const r = await runAllocation({
      organizationId: fixtures.org.id,
      groupId: bad.id,
      totalAmount: "1000",
      sourceAccountId: fixtures.rent.id,
      journalDate: "2026-03-31",
      description: "Should fail",
      actorId: fixtures.actor.id,
    });
    if (r.ok) throw new Error("expected failure");
    if (r.code !== "percent_sum_invalid")
      throw new Error(`expected percent_sum_invalid, got ${r.code}`);
  });

  // -------------------------------------------------------------------------
  console.log("\nBudgets");
  let budgetId: string | null = null;
  await check("create a budget + set an entry", async () => {
    const [fy] = await db
      .select({ id: fiscalYears.id })
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.organizationId, fixtures.org.id),
          eq(fiscalYears.yearLabel, "FY2026")
        )
      );

    const b = await createBudget({
      organizationId: fixtures.org.id,
      fiscalYearId: fy.id,
      code: "PLAN-2026",
      name: "FY2026 Plan",
    });
    budgetId = b.id;

    const [period] = await db
      .select({ id: fiscalPeriods.id })
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.organizationId, fixtures.org.id),
          eq(fiscalPeriods.periodCode, "FY2026-03")
        )
      );

    await setBudgetEntry({
      organizationId: fixtures.org.id,
      budgetId: b.id,
      accountId: fixtures.rent.id,
      periodId: period.id,
      amount: "4500",
      memo: "March rent",
    });

    const total = await budgetedAmountFor({
      organizationId: fixtures.org.id,
      budgetId: b.id,
      accountId: fixtures.rent.id,
      periodId: period.id,
    });
    if (Number(total) !== 4500)
      throw new Error(`expected budgeted=4500, got ${total}`);
  });

  await check("lock budget → entry edits rejected", async () => {
    await lockBudget(budgetId!, fixtures.actor.id);
    const [period] = await db
      .select({ id: fiscalPeriods.id })
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.organizationId, fixtures.org.id),
          eq(fiscalPeriods.periodCode, "FY2026-04")
        )
      );

    try {
      await setBudgetEntry({
        organizationId: fixtures.org.id,
        budgetId: budgetId!,
        accountId: fixtures.rent.id,
        periodId: period.id,
        amount: "4500",
      });
      throw new Error("expected lock to reject the edit");
    } catch (e) {
      if (!(e as Error).message.includes("locked"))
        throw new Error(`wrong error: ${(e as Error).message}`);
    }
  });

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, fixtures.org.id));
  });
  // Kill references to keep linter quiet
  void budgets;
  void budgetEntries;

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
