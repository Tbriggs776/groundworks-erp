/**
 * End-to-end verification of the GL posting engine. Creates an isolated
 * test organization, exercises the happy path + representative failure
 * modes + DB-level immutability, and prints a pass/fail report.
 *
 *   npx tsx scripts/test-posting.ts
 *
 * Idempotent: re-running tears down prior `gl-test-*` orgs before starting.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import {
  accounts,
  auditLog,
  glJournals,
  glLines,
  memberships,
  organizations,
  profiles,
} from "../src/lib/db/schema";
import { generateFiscalYear } from "../src/lib/gl/fiscal-calendar";
import { createAndPostJournal, reverseJournal } from "../src/lib/gl/posting";
import { seedOrganizationDefaults } from "../src/lib/seed/org-defaults";

type Check = (name: string, fn: () => Promise<void>) => Promise<void>;

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;

const check: Check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ${PASS} ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ${FAIL} ${name}`);
    console.log(`     ${(e as Error).message}`);
  }
};

async function main() {
  const testSlug = `gl-test-${Date.now()}`;

  // Clean up prior test data. Set the bypass flag in a transaction so the
  // posting-immutability triggers allow the cascade delete.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(like(organizations.slug, "gl-test-%"));
  });

  // Find any existing profile to use as the test actor (Tyler's signed-in
  // user will be the first profile in the system).
  const [actor] = await db.select().from(profiles).limit(1);
  if (!actor) {
    throw new Error(
      "No profiles found. Log in at least once to create a profile row."
    );
  }

  // Build the test org and fixtures inside a single transaction so all
  // seed data is consistent.
  const fixtures = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: "GL Test Org", slug: testSlug, baseCurrency: "USD" })
      .returning();

    await tx.insert(memberships).values({
      organizationId: org.id,
      userId: actor.id,
      role: "owner",
    });

    await seedOrganizationDefaults(tx, org.id, {
      includeContractorCoa: true,
    });

    const { periodIds } = await generateFiscalYear(tx, {
      organizationId: org.id,
      startDate: "2026-01-01",
      yearLabel: "FY2026",
    });

    // Handy account lookups
    const acctRows = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, org.id));
    const byCode = new Map(acctRows.map((a) => [a.code, a]));

    // Source code lookup
    const [gjSource] = await tx
      .select({ id: sql<string>`id` })
      .from(sql`source_codes`)
      .where(sql`organization_id = ${org.id} AND code = 'GJ'`);

    return {
      org,
      actor,
      periodIds,
      cash: byCode.get("1010")!,
      apTrade: byCode.get("2000")!, // control account
      officeSupplies: byCode.get("6620")!,
      rent: byCode.get("6600")!,
      sourceCodeId: gjSource.id,
    };
  });

  console.log(`\nTest org: ${fixtures.org.slug}  (${fixtures.org.id})\n`);

  console.log("Happy path");
  let firstJournalId: string | null = null;
  await check("post a balanced manual JE", async () => {
    const r = await createAndPostJournal({
      organizationId: fixtures.org.id,
      actorId: fixtures.actor.id,
      journalDate: "2026-03-15",
      sourceCodeId: fixtures.sourceCodeId,
      source: "manual",
      description: "Rent payment — March",
      lines: [
        {
          accountId: fixtures.rent.id,
          debit: "4500.00",
          memo: "Rent",
        },
        {
          accountId: fixtures.cash.id,
          credit: "4500.00",
          memo: "Rent payment",
        },
      ],
    });
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    firstJournalId = r.journalId;
  });

  console.log("\nValidation failures");
  await check("unbalanced journal is rejected", async () => {
    const r = await createAndPostJournal({
      organizationId: fixtures.org.id,
      actorId: fixtures.actor.id,
      journalDate: "2026-03-15",
      sourceCodeId: fixtures.sourceCodeId,
      source: "manual",
      description: "Unbalanced test",
      lines: [
        { accountId: fixtures.rent.id, debit: "100.00" },
        { accountId: fixtures.cash.id, credit: "50.00" }, // short
      ],
    });
    if (r.ok) throw new Error("expected failure, got success");
    if (r.code !== "unbalanced_currency")
      throw new Error(`expected unbalanced_currency, got ${r.code}`);
  });

  await check("manual post to control account is rejected", async () => {
    const r = await createAndPostJournal({
      organizationId: fixtures.org.id,
      actorId: fixtures.actor.id,
      journalDate: "2026-03-15",
      sourceCodeId: fixtures.sourceCodeId,
      source: "manual",
      description: "Manual to AP control",
      lines: [
        {
          accountId: fixtures.apTrade.id, // control account
          debit: "100.00",
        },
        {
          accountId: fixtures.cash.id,
          credit: "100.00",
        },
      ],
    });
    if (r.ok) throw new Error("expected failure, got success");
    if (r.code !== "control_account_manual")
      throw new Error(`expected control_account_manual, got ${r.code}`);
  });

  await check("journal outside any fiscal period fails", async () => {
    try {
      await createAndPostJournal({
        organizationId: fixtures.org.id,
        actorId: fixtures.actor.id,
        journalDate: "2099-01-01", // no period for this
        sourceCodeId: fixtures.sourceCodeId,
        source: "manual",
        description: "Out-of-range date",
        lines: [
          { accountId: fixtures.rent.id, debit: "10.00" },
          { accountId: fixtures.cash.id, credit: "10.00" },
        ],
      });
      throw new Error("expected thrown error");
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("No fiscal period")) {
        throw new Error(`expected 'No fiscal period' error, got: ${msg}`);
      }
    }
  });

  console.log("\nReversal");
  let reversalId: string | null = null;
  await check("reverse the first journal", async () => {
    if (!firstJournalId) throw new Error("no journal to reverse");
    const r = await reverseJournal(firstJournalId, {
      actorId: fixtures.actor.id,
      organizationId: fixtures.org.id,
      reversalDate: "2026-04-01",
      description: "Reversing March rent",
    });
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    reversalId = r.journalId;
  });

  await check("original is now status=reversed", async () => {
    const [row] = await db
      .select({ status: glJournals.status, reversedBy: glJournals.reversedByJournalId })
      .from(glJournals)
      .where(eq(glJournals.id, firstJournalId!));
    if (row.status !== "reversed")
      throw new Error(`expected reversed, got ${row.status}`);
    if (row.reversedBy !== reversalId)
      throw new Error(`reversedBy mismatch`);
  });

  await check("cannot reverse an already-reversed journal", async () => {
    if (!firstJournalId) throw new Error("no journal");
    const r = await reverseJournal(firstJournalId, {
      actorId: fixtures.actor.id,
      organizationId: fixtures.org.id,
    });
    if (r.ok) throw new Error("expected failure");
    if (r.code !== "already_reversed")
      throw new Error(`expected already_reversed, got ${r.code}`);
  });

  console.log("\nDB-level immutability");
  const expectDbError = async (
    fn: () => Promise<unknown>,
    expectedMessageFragments: string[]
  ) => {
    try {
      await fn();
      throw new Error("expected DB to reject the operation");
    } catch (e) {
      // Drizzle wraps errors; walk the `.cause` chain for the real Postgres message.
      const messages: string[] = [];
      let cur: unknown = e;
      while (cur && messages.length < 5) {
        if (cur instanceof Error) messages.push(cur.message);
        cur = (cur as { cause?: unknown }).cause;
      }
      const combined = messages.join(" | ");
      const hit = expectedMessageFragments.some((f) =>
        combined.toLowerCase().includes(f.toLowerCase())
      );
      if (!hit) throw new Error(`unexpected error: ${combined}`);
    }
  };

  await check("cannot UPDATE a posted journal's description", () =>
    expectDbError(
      () =>
        db
          .update(glJournals)
          .set({ description: "tampered" })
          .where(eq(glJournals.id, reversalId!)),
      ["immutable", "posted journals"]
    )
  );

  await check("cannot DELETE a posted journal", () =>
    expectDbError(
      () => db.delete(glJournals).where(eq(glJournals.id, reversalId!)),
      ["cannot delete", "posted"]
    )
  );

  await check("cannot UPDATE a line of a posted journal", async () => {
    const [line] = await db
      .select({ id: glLines.id })
      .from(glLines)
      .where(eq(glLines.journalId, reversalId!))
      .limit(1);
    return expectDbError(
      () =>
        db.update(glLines).set({ memo: "tampered" }).where(eq(glLines.id, line.id)),
      ["posted", "reversed"]
    );
  });

  console.log("\nAudit trail");
  await check("two audit rows for posted journals", async () => {
    const rows = await db
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.organizationId, fixtures.org.id),
          eq(auditLog.event, "gl.journal.posted")
        )
      );
    if (rows.length < 2) {
      throw new Error(`expected >=2 posted audit rows, got ${rows.length}`);
    }
  });

  // Cleanup: drop the test org (cascades to everything). Bypass the
  // posting-immutability triggers so the cascade delete succeeds.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(organizations).where(eq(organizations.id, fixtures.org.id));
  });

  console.log(
    `\n${failed === 0 ? PASS : FAIL} ${
      failed === 0 ? "all checks passed" : `${failed} check(s) failed`
    }\n`
  );

  // process.exit() tears down the postgres connections; skip explicit end()
  // because the lazy proxy wraps `$client` in a way that hides it from .end().
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
