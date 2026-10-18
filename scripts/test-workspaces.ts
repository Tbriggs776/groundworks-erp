/**
 * End-to-end: workspaces. Sign-up (workspace + first company), more
 * companies, people and per-company access, invitations with grants
 * (hashed, email-bound, single use, domain policy), owner guard rails,
 * removal closing every company (and personal API keys), the security
 * policy, access reviews, the workspace audit log, and the API key
 * lifetime policy.
 *
 *   npx tsx scripts/test-workspaces.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { apiKeys, auditLog, invitations, memberships, workspaceMembers, workspaces } from "../src/lib/db/schema";
import { runAs, runAsWorkspace, userActor, workspaceActor, type WorkspaceRole } from "../src/lib/actor";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as agentsSvc from "../src/lib/agents/service";
import * as ws from "../src/lib/workspace/service";
import { assert, assertEq, check, expectError, finish, section } from "./lib/harness";

const stamp = Date.now();
const PREFIX = `wst-${stamp}`;

async function newUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `${tag}-${stamp}@example.com`;
  const [row] = await db.execute<{ id: string }>(sql`INSERT INTO auth.users (email) VALUES (${email}) RETURNING id`);
  return { id: row.id, email };
}

async function main() {
  const owner = await newUser("owner");
  const alice = await newUser("alice");
  const bob = await newUser("bob");
  const mallory = await newUser("mallory");

  let workspaceId = "";
  let acmeId = "";
  let betaId = "";
  const as = (userId: string, role: WorkspaceRole) => workspaceActor({ workspaceId, userId, role });
  const asOwner = () => as(owner.id, "owner");

  section("Sign-up");
  await check("sign-up creates a workspace, its first company, and owner seats in both", async () => {
    const r = await db.transaction((tx) =>
      ws.createWorkspace(tx, owner, { name: `${PREFIX} Acme`, workspaceName: `${PREFIX} Holdings`, fullName: "Olive Owner" })
    );
    workspaceId = r.workspaceId;
    acmeId = r.organizationId;
    const [seat] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    assertEq(seat.role, "owner", "workspace role");
    const [m] = await db.select().from(memberships).where(eq(memberships.organizationId, acmeId));
    assertEq(m.role, "owner", "company role");
    const events = await db.select({ e: auditLog.event, org: auditLog.organizationId }).from(auditLog).where(eq(auditLog.workspaceId, workspaceId));
    assert(events.some((x) => x.e === "workspace.created" && x.org === null), "workspace.created is a workspace-level row");
    assert(events.some((x) => x.e === "organization.created" && x.org === acmeId), "organization.created has its workspace filled in");
  });

  await check("an admin adds a second company; a member can't", async () => {
    betaId = (await runAsWorkspace(asOwner(), (ctx) => ws.createCompany(ctx, { name: `${PREFIX} Beta`, baseCurrency: "cad" }))).id;
    const companies = await runAsWorkspace(asOwner(), (ctx) => ws.listCompanies(ctx));
    assertEq(companies.length, 2, "two companies");
    assertEq(companies.find((c) => c.id === betaId)?.baseCurrency, "CAD", "currency normalized");
    await expectError(() => runAsWorkspace(as(owner.id, "member"), (ctx) => ws.createCompany(ctx, { name: "Nope Co" })), "forbidden");
  });

  section("Invitations");
  let aliceToken = "";
  await check("invite alice with access to both companies; only a hash is stored", async () => {
    const r = await runAsWorkspace(asOwner(), (ctx) =>
      ws.createInvitation(ctx, {
        email: alice.email.toUpperCase(),
        grants: [
          { organizationId: acmeId, role: "bookkeeper" },
          { organizationId: betaId, role: "viewer" },
        ],
      })
    );
    aliceToken = r.token;
    assertEq(r.invitation.email, alice.email, "email normalized");
    assertEq(r.companyNames.length, 2, "company names for the email");
    const [row] = await db.select().from(invitations).where(eq(invitations.id, r.invitation.id));
    assert(row.token !== r.token && row.token.length === 64, "stored token is a sha256 hex");
  });

  await check("grants must point at companies in this workspace", async () => {
    const other = await db.transaction((tx) => ws.createWorkspace(tx, mallory, { name: `${PREFIX} Mallory Co` }));
    await expectError(
      () =>
        runAsWorkspace(asOwner(), (ctx) =>
          ws.createInvitation(ctx, { email: bob.email, grants: [{ organizationId: other.organizationId, role: "owner" }] })
        ),
      "not_found"
    );
  });

  await check("only owners invite owners; members can't invite", async () => {
    await expectError(
      () => runAsWorkspace(as(owner.id, "admin"), (ctx) => ws.createInvitation(ctx, { email: bob.email, workspaceRole: "owner" })),
      "forbidden"
    );
    await expectError(() => runAsWorkspace(as(owner.id, "member"), (ctx) => ws.createInvitation(ctx, { email: bob.email })), "forbidden");
  });

  await check("someone else can't use alice's link", async () => {
    await expectError(() => db.transaction((tx) => ws.acceptInvitation(tx, mallory, aliceToken)), "forbidden");
  });

  await check("alice accepts: a workspace seat plus both companies; the link is single use", async () => {
    const r = await db.transaction((tx) => ws.acceptInvitation(tx, alice, aliceToken));
    assertEq(r.organizationId, acmeId, "lands on the first company");
    const people = await runAsWorkspace(asOwner(), (ctx) => ws.listPeople(ctx));
    const a = people.find((p) => p.userId === alice.id)!;
    assertEq(a.role, "member", "workspace role");
    assertEq(a.companies[acmeId], "bookkeeper", "acme role");
    assertEq(a.companies[betaId], "viewer", "beta role");
    await expectError(() => db.transaction((tx) => ws.acceptInvitation(tx, alice, aliceToken)), "not_found");
  });

  await check("inviting someone already in the workspace is a conflict", async () => {
    await expectError(() => runAsWorkspace(asOwner(), (ctx) => ws.createInvitation(ctx, { email: alice.email })), "conflict");
  });

  await check("re-inviting refreshes the link; revoked and expired links are dead", async () => {
    const first = await runAsWorkspace(asOwner(), (ctx) => ws.createInvitation(ctx, { email: bob.email }));
    const second = await runAsWorkspace(asOwner(), (ctx) => ws.createInvitation(ctx, { email: bob.email, workspaceRole: "admin" }));
    assertEq(await db.transaction((tx) => ws.findInvitation(tx, first.token)), null, "old link dead");
    assertEq((await runAsWorkspace(asOwner(), (ctx) => ws.listInvitations(ctx))).length, 1, "one pending invite");
    await db.update(invitations).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(invitations.id, second.invitation.id));
    assertEq(await db.transaction((tx) => ws.findInvitation(tx, second.token)), null, "expired");
    const third = await runAsWorkspace(asOwner(), (ctx) => ws.createInvitation(ctx, { email: bob.email }));
    await runAsWorkspace(asOwner(), (ctx) => ws.revokeInvitation(ctx, { id: third.invitation.id }));
    assertEq(await db.transaction((tx) => ws.findInvitation(tx, third.token)), null, "revoked");
  });

  await check("allowed email domains gate invitations", async () => {
    const policy = await runAsWorkspace(asOwner(), (ctx) => ws.getSecurityPolicy(ctx));
    await runAsWorkspace(asOwner(), (ctx) => ws.updateSecurityPolicy(ctx, { ...policy, allowedEmailDomains: ["@Acme.com"] }));
    await expectError(() => runAsWorkspace(asOwner(), (ctx) => ws.createInvitation(ctx, { email: bob.email })), "forbidden");
    await runAsWorkspace(asOwner(), (ctx) => ws.createInvitation(ctx, { email: `x-${stamp}@acme.com` }));
    await runAsWorkspace(asOwner(), (ctx) => ws.updateSecurityPolicy(ctx, { ...policy, allowedEmailDomains: [] }));
  });

  section("People and company access");
  await check("members see only companies they can open", async () => {
    await runAsWorkspace(asOwner(), (ctx) => ws.setCompanyAccess(ctx, { userId: alice.id, organizationId: betaId, role: null }));
    const seen = await runAsWorkspace(as(alice.id, "member"), (ctx) => ws.listCompanies(ctx));
    assertEq(seen.map((c) => c.id).join(), acmeId, "only acme");
  });

  await check("access changes are audited at company level", async () => {
    await runAsWorkspace(asOwner(), (ctx) => ws.setCompanyAccess(ctx, { userId: alice.id, organizationId: acmeId, role: "accountant" }));
    const rows = await db
      .select({ e: auditLog.event, md: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, acmeId), like(auditLog.event, "membership.%")));
    const upd = rows.find((r) => r.e === "membership.updated");
    assert(upd && (upd.md as { before: string }).before === "bookkeeper", "membership.updated with before/after");
    assert(rows.length >= 1 && (await db.select().from(auditLog).where(and(eq(auditLog.organizationId, betaId), eq(auditLog.event, "membership.revoked")))).length === 1, "revoke audited");
  });

  await check("only an owner makes owners; the last owner can't step down", async () => {
    await expectError(() => runAsWorkspace(as(owner.id, "admin"), (ctx) => ws.updatePerson(ctx, { userId: alice.id, role: "owner" })), "forbidden");
    await expectError(() => runAsWorkspace(asOwner(), (ctx) => ws.updatePerson(ctx, { userId: owner.id, role: "admin" })), "invalid_state");
    await expectError(() => runAsWorkspace(asOwner(), (ctx) => ws.updatePerson(ctx, { userId: owner.id, isActive: false })), "invalid_state");
  });

  await check("removing alice closes every company and kills her personal key on the next call", async () => {
    const aliceCompany = userActor({ organizationId: acmeId, userId: alice.id, role: "accountant" });
    const { token } = await runAs(aliceCompany, (ctx) => agentsSvc.createApiKey(ctx, { name: "laptop" }));
    await authenticateApiKey(token, "api");
    await runAsWorkspace(asOwner(), (ctx) => ws.updatePerson(ctx, { userId: alice.id, isActive: false }));
    const live = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, alice.id), eq(memberships.isActive, true)));
    assertEq(live.length, 0, "no live company access");
    await expectError(() => authenticateApiKey(token, "api"), "unauthenticated");
    await expectError(
      () => runAsWorkspace(asOwner(), (ctx) => ws.setCompanyAccess(ctx, { userId: alice.id, organizationId: acmeId, role: "viewer" })),
      "invalid_state"
    );
  });

  await check("a personal key also dies with the workspace seat alone", async () => {
    await runAsWorkspace(asOwner(), (ctx) => ws.updatePerson(ctx, { userId: alice.id, isActive: true }));
    await runAsWorkspace(asOwner(), (ctx) => ws.setCompanyAccess(ctx, { userId: alice.id, organizationId: acmeId, role: "bookkeeper" }));
    const aliceCompany = userActor({ organizationId: acmeId, userId: alice.id, role: "bookkeeper" });
    const { token } = await runAs(aliceCompany, (ctx) => agentsSvc.createApiKey(ctx, { name: "desk" }));
    await authenticateApiKey(token, "api");
    await db.update(workspaceMembers).set({ isActive: false }).where(and(eq(workspaceMembers.userId, alice.id), eq(workspaceMembers.workspaceId, workspaceId)));
    await expectError(() => authenticateApiKey(token, "api"), "unauthenticated");
    await db.update(workspaceMembers).set({ isActive: true }).where(and(eq(workspaceMembers.userId, alice.id), eq(workspaceMembers.workspaceId, workspaceId)));
  });

  await check("admins can't change a workspace owner's company access", async () => {
    await expectError(
      () => runAsWorkspace(as(alice.id, "admin"), (ctx) => ws.setCompanyAccess(ctx, { userId: owner.id, organizationId: acmeId, role: null })),
      "forbidden"
    );
  });

  await check("members don't see teammates' activity or MFA status (only their own)", async () => {
    const seen = await runAsWorkspace(as(alice.id, "member"), (ctx) => ws.listPeople(ctx));
    const o = seen.find((p) => p.userId === owner.id)!;
    assertEq(o.mfaEnabled, null, "owner's MFA hidden");
    assertEq(o.lastSeenAt, null, "owner's activity hidden");
    assertEq(seen.find((p) => p.userId === alice.id)!.mfaEnabled, false, "own MFA status visible");
  });

  section("Security policy");
  await check("admins change the policy (audited with before/after); members can't", async () => {
    const before = await runAsWorkspace(asOwner(), (ctx) => ws.getSecurityPolicy(ctx));
    const after = await runAsWorkspace(as(owner.id, "admin"), (ctx) =>
      ws.updateSecurityPolicy(ctx, { ...before, requireMfa: true, sessionIdleMinutes: 30, apiKeyMaxDays: 90 })
    );
    assertEq(after.requireMfa, true, "mfa");
    assertEq(after.sessionIdleMinutes, 30, "idle");
    const [row] = await db
      .select({ md: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.event, "workspace.security_policy.updated")));
    assertEq((row.md as { before: { requireMfa: boolean } }).before.requireMfa, false, "before captured");
    await expectError(() => runAsWorkspace(as(alice.id, "member"), (ctx) => ws.updateSecurityPolicy(ctx, before)), "forbidden");
    await expectError(
      () => runAsWorkspace(asOwner(), (ctx) => ws.updateSecurityPolicy(ctx, { ...before, sessionIdleMinutes: 600, sessionMaxHours: 2 })),
      "invalid_input"
    );
    await expectError(
      () => runAsWorkspace(asOwner(), (ctx) => ws.updateSecurityPolicy(ctx, { ...before, allowedEmailDomains: ["not a domain"] })),
      "invalid_input"
    );
  });

  await check("API keys must expire within the workspace limit (and default to it)", async () => {
    const ownerCompany = userActor({ organizationId: acmeId, userId: owner.id, role: "owner" });
    await expectError(() => runAs(ownerCompany, (ctx) => agentsSvc.createApiKey(ctx, { name: "long", expiresInDays: 365 })), "invalid_input");
    const { key } = await runAs(ownerCompany, (ctx) => agentsSvc.createApiKey(ctx, { name: "default" }));
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    const days = Math.round((row.expiresAt!.getTime() - Date.now()) / 86_400_000);
    assertEq(days, 90, "defaults to the 90-day limit");
  });

  section("Access review and audit");
  await check("the snapshot covers people, agents, and live keys; completing it freezes the evidence", async () => {
    const ownerCompany = userActor({ organizationId: acmeId, userId: owner.id, role: "owner" });
    await runAs(ownerCompany, (ctx) => agentsSvc.createAgent(ctx, { name: `Reviewer bot ${stamp}`, autonomy: "draft" }));
    const snap = await runAsWorkspace(asOwner(), (ctx) => ws.accessSnapshot(ctx));
    assert(snap.people.some((p) => p.email === alice.email && p.companies.some((c) => c.role === "bookkeeper")), "alice listed with her role");
    assert(snap.agents.some((a) => a.name === `Reviewer bot ${stamp}`), "agent listed");
    assert(snap.apiKeys.length >= 2, "live keys listed");
    const { id } = await runAsWorkspace(asOwner(), (ctx) => ws.completeAccessReview(ctx, { notes: "Q3 review" }));
    const review = await runAsWorkspace(asOwner(), (ctx) => ws.getAccessReview(ctx, { id }));
    assertEq(review.snapshot.people.length, snap.people.length, "frozen snapshot");
    await expectError(() => runAsWorkspace(as(alice.id, "member"), (ctx) => ws.accessSnapshot(ctx)), "forbidden");
  });

  await check("the workspace audit log spans companies and filters by event prefix", async () => {
    const all = await runAsWorkspace(asOwner(), (ctx) => ws.listWorkspaceAudit(ctx, { limit: 500 }));
    assert(all.some((r) => r.company === null) && all.some((r) => r.company !== null), "workspace and company rows");
    const inv = await runAsWorkspace(asOwner(), (ctx) => ws.listWorkspaceAudit(ctx, { event: "invitation." }));
    assert(inv.length > 0 && inv.every((r) => r.event.startsWith("invitation.")), "prefix filter");
    const beta = await runAsWorkspace(asOwner(), (ctx) => ws.listWorkspaceAudit(ctx, { organizationId: betaId }));
    assert(beta.every((r) => r.company === `${PREFIX} Beta`), "company filter");
    await expectError(() => runAsWorkspace(as(alice.id, "member"), (ctx) => ws.listWorkspaceAudit(ctx, {})), "forbidden");
  });

  await check("audit rows can't be edited, and every row has a workspace", async () => {
    let blocked = false;
    try {
      await db.execute(sql`UPDATE audit_log SET event = 'tampered' WHERE workspace_id = ${workspaceId}`);
    } catch {
      blocked = true;
    }
    assert(blocked, "UPDATE rejected");
    let orphan = false;
    try {
      await db.insert(auditLog).values({ event: "orphan" });
    } catch {
      orphan = true;
    }
    assert(orphan, "a row with neither company nor workspace is rejected");
  });

  // Cleanup: fixture workspaces cascade to their companies.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_posting_locks = 'true'`);
    await tx.delete(workspaces).where(like(workspaces.name, `${PREFIX}%`));
  });
  await db.execute(sql`DELETE FROM auth.users WHERE email LIKE ${`%-${stamp}@example.com`}`);
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
