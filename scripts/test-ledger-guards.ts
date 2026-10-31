/**
 * End-to-end: the ledger's safety rails outside the posting engine.
 * An agent's posting limit covers reversals and voids; allocations and FX
 * revaluation check scope, role, and the limit; the database refuses an
 * unbalanced posted journal and new lines on a posted one.
 *
 *   npx tsx scripts/test-ledger-guards.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { glJournals, glLines, sourceCodes } from "../src/lib/db/schema";
import type { Actor } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import { runAllocation } from "../src/lib/gl/allocations";
import { runFxRevaluation } from "../src/lib/gl/fx-revaluation";
import * as journals from "../src/lib/gl/journals";
import { createAndPostJournal } from "../src/lib/gl/posting";
import { account, assert, assertEq, check, createTestOrg, expectError, finish, section } from "./lib/harness";

async function main() {
  const t = await createTestOrg("ledger-guards-test-");
  const owner = t.as("owner");
  const cash = account(t, "1010");
  const rent = account(t, "6600");
  const [gj] = await db
    .select()
    .from(sourceCodes)
    .where(and(eq(sourceCodes.organizationId, t.org.id), eq(sourceCodes.code, "GJ")));

  const post = async (amount: string) => {
    const r = await createAndPostJournal({
      organizationId: t.org.id,
      actorId: null,
      journalDate: "2026-03-15",
      sourceCodeId: gj.id,
      source: "manual",
      description: `Rent ${amount}`,
      lines: [
        { accountId: rent.id, debit: amount },
        { accountId: cash.id, credit: amount },
      ],
    });
    if (!r.ok) throw new Error(r.error);
    return r.journalId;
  };

  const agentId = await t.run(owner, async (ctx) =>
    (await agentsSvc.createAgent(ctx, { name: "Ledger bot", role: "accountant", autonomy: "post", maxPostAmount: "100" })).id
  );
  const agent: Actor = {
    ...t.as("accountant"),
    kind: "agent",
    userId: null,
    agentId,
    agentName: "Ledger bot",
    channel: "api",
    maxPostAmount: "100.0000",
  };

  section("Reversals respect the agent's posting limit");

  await check("an agent can't reverse an entry above its limit", async () => {
    const id = await post("500.00");
    await expectError(() => t.run(agent, (ctx) => journals.reverseJournalEntry(ctx, { id })), "approval_required");
    const [j] = await db.select().from(glJournals).where(eq(glJournals.id, id));
    assertEq(j.status, "posted", "original untouched");
  });

  await check("an agent can reverse an entry within its limit", async () => {
    const id = await post("80.00");
    const rev = await t.run(agent, (ctx) => journals.reverseJournalEntry(ctx, { id }));
    assertEq(rev.status, "posted", "reversal posted");
  });

  await check("a person reverses any amount", async () => {
    const id = await post("5000.00");
    const rev = await t.run(owner, (ctx) => journals.reverseJournalEntry(ctx, { id }));
    assertEq(rev.status, "posted", "reversal posted");
  });

  section("Allocations and FX revaluation check permissions");

  const allocation = (actor: Actor, totalAmount: string) =>
    runAllocation({
      actor,
      groupId: "00000000-0000-0000-0000-000000000000",
      totalAmount,
      sourceAccountId: rent.id,
      journalDate: "2026-03-31",
      description: "Guard check",
    });

  await check("a bookkeeper can't run an allocation", async () => {
    await expectError(() => allocation(t.as("bookkeeper"), "10"), "forbidden");
  });

  await check("a read-only key can't run an allocation", async () => {
    await expectError(() => allocation({ ...owner, scopes: ["read", "write"] }, "10"), "forbidden");
  });

  await check("an agent can't run an allocation above its limit", async () => {
    await expectError(() => allocation(agent, "1000"), "approval_required");
  });

  await check("a bookkeeper can't post an FX revaluation", async () => {
    await expectError(
      () =>
        runFxRevaluation({
          actor: t.as("bookkeeper"),
          asOfDate: "2026-03-31",
          fxGainAccountId: cash.id,
          fxLossAccountId: cash.id,
          sourceCodeId: gj.id,
        }),
      "forbidden"
    );
  });

  section("The database refuses unbalanced posted journals");

  await check("posting an unbalanced draft directly fails at commit", async () => {
    const draft = await t.run(owner, (ctx) =>
      journals.createJournalEntry(ctx, {
        date: "2026-03-20",
        description: "Will be unbalanced",
        lines: [{ accountId: rent.id, debit: "100" }, { accountId: cash.id, credit: "100" }],
      })
    );
    const creditLine = draft.lines.find((l) => l.accountId === cash.id)!;
    let failed = false;
    try {
      await db.transaction(async (tx) => {
        await tx.update(glLines).set({ credit: "90", creditLocal: "90" }).where(eq(glLines.id, creditLine.id));
        await tx.update(glJournals).set({ status: "posted" }).where(eq(glJournals.id, draft.id));
      });
    } catch (e) {
      failed = /does not balance/.test(String((e as { cause?: unknown }).cause ?? e));
    }
    assert(failed, "unbalanced journal was refused");
  });

  await check("a line can't be added to a posted journal", async () => {
    const id = await post("40.00");
    let failed = false;
    try {
      const [line] = await db.select().from(glLines).where(eq(glLines.journalId, id)).limit(1);
      await db.insert(glLines).values({ ...line, id: crypto.randomUUID(), lineNumber: 9 });
    } catch (e) {
      failed = /Cannot add a line/.test(String((e as { cause?: unknown }).cause ?? e));
    }
    assert(failed, "insert refused");
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(glLines).where(eq(glLines.journalId, id));
    assertEq(n, 2, "still two lines");
  });

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
