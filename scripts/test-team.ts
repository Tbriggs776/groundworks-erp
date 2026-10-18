/**
 * End-to-end: team management — invitations (hashed tokens, email match,
 * single use, refresh, revoke) and member changes (owner-only owner
 * grants, last-owner protection, deactivation killing API keys).
 *
 *   npx tsx scripts/test-team.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { invitations, memberships } from "../src/lib/db/schema";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as agentsSvc from "../src/lib/agents/service";
import { userActor } from "../src/lib/actor";
import * as team from "../src/lib/team/service";
import {
  assert,
  assertEq,
  check,
  createTestOrg,
  deleteOrgs,
  expectError,
  finish,
  section,
} from "./lib/harness";

async function newUser(email: string): Promise<{ id: string; email: string }> {
  const [row] = await db.execute<{ id: string }>(
    sql`INSERT INTO auth.users (email) VALUES (${email}) RETURNING id`
  );
  return { id: row.id, email };
}

async function main() {
  const t = await createTestOrg("team-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const owner = t.as("owner");
  const stamp = Date.now();
  const alice = await newUser(`alice-${stamp}@example.com`);
  const mallory = await newUser(`mallory-${stamp}@example.com`);

  section("Invitations");
  let aliceToken = "";
  await check("owner invites alice as bookkeeper; only a hash is stored", async () => {
    const r = await t.run(owner, (ctx) => team.createInvitation(ctx, { email: alice.email.toUpperCase(), role: "bookkeeper" }));
    aliceToken = r.token;
    assertEq(r.invitation.email, alice.email, "email normalized");
    const [row] = await db.select().from(invitations).where(eq(invitations.id, r.invitation.id));
    assert(row.token !== r.token && row.token.length === 64, "stored token is a sha256 hex");
  });

  await check("someone else can't use alice's link", async () => {
    await expectError(() => db.transaction((tx) => team.acceptInvitation(tx, mallory, aliceToken)), "forbidden");
  });

  await check("re-inviting refreshes the link; the old one stops working", async () => {
    const r = await t.run(owner, (ctx) => team.createInvitation(ctx, { email: alice.email, role: "accountant" }));
    await expectError(() => db.transaction((tx) => team.acceptInvitation(tx, alice, aliceToken)), "not_found");
    aliceToken = r.token;
    const pending = await t.run(owner, (ctx) => team.listInvitations(ctx));
    assertEq(pending.length, 1, "still one pending invite");
    assert(!("token" in pending[0]), "list never exposes the token");
  });

  await check("alice accepts as accountant; the link is single-use", async () => {
    const r = await db.transaction((tx) => team.acceptInvitation(tx, alice, aliceToken));
    assertEq(r.organizationId, t.org.id, "org");
    const members = await t.run(owner, (ctx) => team.listMembers(ctx));
    assertEq(members.find((m) => m.userId === alice.id)?.role, "accountant", "role");
    await expectError(() => db.transaction((tx) => team.acceptInvitation(tx, alice, aliceToken)), "not_found");
  });

  await check("inviting an existing member is a conflict", async () => {
    await expectError(() => t.run(owner, (ctx) => team.createInvitation(ctx, { email: alice.email })), "conflict");
  });

  await check("expired and revoked invites are dead", async () => {
    const a = await t.run(owner, (ctx) => team.createInvitation(ctx, { email: `late-${stamp}@example.com` }));
    await db.update(invitations).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(invitations.id, a.invitation.id));
    assertEq(await db.transaction((tx) => team.findInvitation(tx, a.token)), null, "expired");
    const b = await t.run(owner, (ctx) => team.createInvitation(ctx, { email: `nope-${stamp}@example.com` }));
    await t.run(owner, (ctx) => team.revokeInvitation(ctx, { id: b.invitation.id }));
    assertEq(await db.transaction((tx) => team.findInvitation(tx, b.token)), null, "revoked");
  });

  await check("admins can't invite owners; bookkeepers can't invite at all", async () => {
    await expectError(
      () => t.run(t.as("admin"), (ctx) => team.createInvitation(ctx, { email: `x-${stamp}@example.com`, role: "owner" })),
      "forbidden"
    );
    await expectError(
      () => t.run(t.as("bookkeeper"), (ctx) => team.createInvitation(ctx, { email: `y-${stamp}@example.com` })),
      "forbidden"
    );
  });

  section("Members");
  const ownerMembership = async () =>
    (await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.organizationId, t.org.id), eq(memberships.userId, t.owner.id))))[0];

  await check("the last owner can't be demoted or deactivated", async () => {
    const m = await ownerMembership();
    await expectError(() => t.run(owner, (ctx) => team.updateMember(ctx, { membershipId: m.id, role: "admin" })), "invalid_state");
    await expectError(() => t.run(owner, (ctx) => team.updateMember(ctx, { membershipId: m.id, isActive: false })), "invalid_state");
  });

  await check("an admin can't promote someone to owner", async () => {
    const aliceM = (await t.run(owner, (ctx) => team.listMembers(ctx))).find((m) => m.userId === alice.id)!;
    await expectError(
      () => t.run(t.as("admin"), (ctx) => team.updateMember(ctx, { membershipId: aliceM.membershipId, role: "owner" })),
      "forbidden"
    );
  });

  await check("with a second owner, the first can step down", async () => {
    const aliceM = (await t.run(owner, (ctx) => team.listMembers(ctx))).find((m) => m.userId === alice.id)!;
    await t.run(owner, (ctx) => team.updateMember(ctx, { membershipId: aliceM.membershipId, role: "owner" }));
    const m = await ownerMembership();
    const r = await t.run(owner, (ctx) => team.updateMember(ctx, { membershipId: m.id, role: "admin" }));
    assertEq(r.role, "admin", "stepped down");
    await db.update(memberships).set({ role: "owner" }).where(eq(memberships.id, m.id));
  });

  await check("deactivating a member kills their personal API keys immediately", async () => {
    const aliceActor = userActor({ organizationId: t.org.id, userId: alice.id, role: "owner" });
    const { token } = await t.run(aliceActor, (ctx) => agentsSvc.createApiKey(ctx, { name: "laptop" }));
    await authenticateApiKey(token, "api");
    const aliceM = (await t.run(owner, (ctx) => team.listMembers(ctx))).find((m) => m.userId === alice.id)!;
    await t.run(owner, (ctx) => team.updateMember(ctx, { membershipId: aliceM.membershipId, isActive: false }));
    await expectError(() => authenticateApiKey(token, "api"), "unauthenticated");
  });

  await deleteOrgs("team-test-");
  await db.execute(sql`DELETE FROM auth.users WHERE email LIKE ${`%-${stamp}@example.com`}`);
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
