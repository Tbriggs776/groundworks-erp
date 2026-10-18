/**
 * Shared scaffolding for the e2e suites in scripts/test-*.ts: a check()
 * runner, a disposable organization with the default CoA + FY2026 periods,
 * actors for each role, and cleanup.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq, sql } from "drizzle-orm";
import { db } from "../../src/lib/db/client";
import {
  accounts,
  memberships,
  organizations,
  profiles,
  workspaceMembers,
  type Account,
  type Organization,
  type Profile,
} from "../../src/lib/db/schema";
import { runAs, userActor, type Actor, type Ctx, type Role } from "../../src/lib/actor";
import { AppError, toAppError } from "../../src/lib/errors";
import { generateFiscalYear } from "../../src/lib/gl/fiscal-calendar";
import { seedOrganizationDefaults } from "../../src/lib/seed/org-defaults";
import { deleteFixtures, testWorkspace } from "./workspace";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;

export function section(title: string) {
  console.log(`\n${title}`);
}

export async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ${PASS} ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ${FAIL} ${name}`);
    console.log(`     ${(e as Error).message}`);
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Run fn and require it to fail with the given AppError code. */
export async function expectError(
  fn: () => Promise<unknown>,
  code: AppError["code"]
): Promise<AppError> {
  try {
    await fn();
  } catch (e) {
    const err = toAppError(e);
    if (err.code !== code) {
      throw new Error(`expected error ${code}, got ${err.code}: ${err.message}`);
    }
    return err;
  }
  throw new Error(`expected error ${code}, but the call succeeded`);
}

export type TestOrg = {
  org: Organization;
  owner: Profile;
  accounts: Map<string, Account>;
  /** Actor for the owner, or for the owner's profile wearing another role. */
  as: (role?: Role) => Actor;
  /** Run a service call in its own transaction as `actor`. */
  run: <T>(actor: Actor, fn: (ctx: Ctx) => Promise<T>) => Promise<T>;
};

export async function deleteOrgs(slugPrefix: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await deleteFixtures(tx, slugPrefix);
  });
}

/** Fresh org with default seeds + FY2026 monthly periods. */
export async function createTestOrg(slugPrefix: string): Promise<TestOrg> {
  await deleteOrgs(slugPrefix);
  const [owner] = await db.select().from(profiles).limit(1);
  if (!owner) throw new Error("No profiles. Run scripts/dev/reset-test-db.sh first.");

  const org = await db.transaction(async (tx) => {
    const slug = `${slugPrefix}${Date.now()}`;
    const workspaceId = await testWorkspace(tx, slug, `Test ${slugPrefix}`);
    await tx.insert(workspaceMembers).values({ workspaceId, userId: owner.id, role: "owner" });
    const [o] = await tx
      .insert(organizations)
      .values({ workspaceId, name: `Test ${slugPrefix}`, slug })
      .returning();
    await tx
      .insert(memberships)
      .values({ organizationId: o.id, userId: owner.id, role: "owner" });
    await seedOrganizationDefaults(tx, o.id, { includeDefaultCoa: true });
    await generateFiscalYear(tx, {
      organizationId: o.id,
      startDate: "2026-01-01",
      yearLabel: "FY2026",
    });
    return o;
  });

  const accts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.organizationId, org.id));

  return {
    org,
    owner,
    accounts: new Map(accts.map((a) => [a.code, a])),
    as: (role: Role = "owner") =>
      userActor({ organizationId: org.id, userId: owner.id, role }),
    run: (actor, fn) => runAs(actor, fn),
  };
}

export function finish(): never {
  console.log(
    `\n${failed === 0 ? PASS : FAIL} ${
      failed === 0 ? "all checks passed" : `${failed} check(s) failed`
    }\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

export function account(t: TestOrg, code: string): Account {
  const a = t.accounts.get(code);
  if (!a) throw new Error(`Seeded account ${code} not found`);
  return a;
}
