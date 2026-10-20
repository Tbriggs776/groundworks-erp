/**
 * Groundworks support access: off by default, owner-granted for a set
 * time, staff only with two-step verification, read-only, revocable, and
 * every step in the workspace's audit log.
 *
 *   npx tsx scripts/test-support-access.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, supportAccessGrants, workspaceMembers, workspaces } from "../src/lib/db/schema";
import { runAs, runAsWorkspace, userActor, workspaceActor, type WorkspaceRole } from "../src/lib/actor";
import * as agentsSvc from "../src/lib/agents/service";
import * as parties from "../src/lib/parties/service";
import * as support from "../src/lib/security/support";
import * as ws from "../src/lib/workspace/service";
import { assert, assertEq, check, expectError, finish, section } from "./lib/harness";

const stamp = Date.now();

async function newUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `${tag}-${stamp}@example.com`;
  const [row] = await db.execute<{ id: string }>(sql`INSERT INTO auth.users (email) VALUES (${email}) RETURNING id`);
  return { id: row.id, email };
}

async function events(workspaceId: string): Promise<string[]> {
  const rows = await db.select({ e: auditLog.event }).from(auditLog).where(eq(auditLog.workspaceId, workspaceId));
  return rows.map((r) => r.e);
}

async function main() {
  const owner = await newUser("sa-owner");
  const admin = await newUser("sa-admin");
  const staff = await newUser("sa-staff");
  const stranger = await newUser("sa-stranger");
  process.env.GROUNDWORKS_SUPPORT_USER_IDS = ` ${staff.id.toUpperCase()} , someone-else `;

  const { workspaceId, organizationId } = await db.transaction((tx) =>
    ws.createWorkspace(tx, owner, { name: `Support Test ${stamp}`, fullName: "Owner" })
  );
  await db.insert(workspaceMembers).values({ workspaceId, userId: admin.id, role: "admin" });
  const as = (userId: string, role: WorkspaceRole) => workspaceActor({ workspaceId, userId, role });
  const visible = async (userId: string, aal = "aal2") =>
    (await support.supportWorkspacesFor(userId, aal)).some((w) => w.workspaceId === workspaceId);

  section("Off by default");
  await check("staff can't see the workspace before anyone allows it", async () => {
    assert(support.isSupportStaff(staff.id), "staff list parsed (case and spaces ignored)");
    assert(!support.isSupportStaff(stranger.id), "stranger isn't staff");
    assert(!(await visible(staff.id)), "not visible");
    const view = await runAsWorkspace(as(owner.id, "owner"), (ctx) => support.getSupportAccess(ctx));
    assertEq(view.active, null, "no active grant");
  });

  section("Granting");
  await check("only the owner can turn it on; admins and members can't", async () => {
    await expectError(() => runAsWorkspace(as(admin.id, "admin"), (ctx) => support.grantSupportAccess(ctx, { days: 1 })), "forbidden");
    await expectError(() => runAsWorkspace(as(admin.id, "member"), (ctx) => support.grantSupportAccess(ctx, { days: 1 })), "forbidden");
    await expectError(() => runAsWorkspace(as(owner.id, "owner"), (ctx) => support.grantSupportAccess(ctx, { days: 30 as 7 })), "invalid_input");
  });

  await check("the owner allows 3 days: audited, and the expiry is 3 days out", async () => {
    const g = await runAsWorkspace(as(owner.id, "owner"), (ctx) => support.grantSupportAccess(ctx, { days: 3 }));
    const hours = (g.expiresAt.getTime() - Date.now()) / 3_600_000;
    assert(hours > 71 && hours <= 72, `expires in ${hours.toFixed(1)}h`);
    assert((await events(workspaceId)).includes("support_access.granted"), "granted event");
  });

  section("Who gets in");
  await check("staff with two-step verification sees it; without it, or not staff, sees nothing", async () => {
    assert(await visible(staff.id, "aal2"), "staff + MFA");
    assert(!(await visible(staff.id, "aal1")), "staff without MFA");
    assert(!(await visible(stranger.id, "aal2")), "stranger");
    assert(!(await visible(owner.id, "aal2")), "the owner isn't staff either");
  });

  await check("support is read-only: no writes, no API keys", async () => {
    const actor = userActor({ organizationId, userId: staff.id, role: "owner", support: true });
    assertEq(actor.role, "viewer", "role capped at viewer");
    assertEq(actor.scopes.join(","), "read", "read scope only");
    await runAs(actor, (ctx) => parties.listCustomers(ctx, {})); // reading works
    await expectError(() => runAs(actor, (ctx) => parties.createCustomer(ctx, { name: "Support was here" })), "forbidden");
    await expectError(() => runAs(actor, (ctx) => agentsSvc.createApiKey(ctx, { name: "backdoor" })), "forbidden");
  });

  await check("each visit lands in the workspace audit log, shown on the Security page", async () => {
    const [{ id }] = await support.supportWorkspacesFor(staff.id, "aal2").then((r) => r.filter((w) => w.workspaceId === workspaceId).map((w) => ({ id: w.grantId })));
    await support.recordSupportOpened(staff.id, workspaceId, id, { ipAddress: "203.0.113.9", userAgent: "test" });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.event, "support_access.opened")));
    assertEq(row.actorId, staff.id, "actor is the staff member");
    assertEq(row.ipAddress, "203.0.113.9", "ip kept");
    const view = await runAsWorkspace(as(owner.id, "owner"), (ctx) => support.getSupportAccess(ctx));
    assert(view.active, "active grant shown");
    assert(view.history.some((h) => h.event === "support_access.opened" && h.who === staff.email), "visit in history");
  });

  section("Ending it");
  await check("an admin can turn it off early; staff loses access at once", async () => {
    const r = await runAsWorkspace(as(admin.id, "admin"), (ctx) => support.revokeSupportAccess(ctx));
    assertEq(r.ended, 1, "one grant ended");
    assert(!(await visible(staff.id)), "gone");
    assert((await events(workspaceId)).includes("support_access.revoked"), "revoked event");
  });

  await check("expiry ends it without anyone acting", async () => {
    await runAsWorkspace(as(owner.id, "owner"), (ctx) => support.grantSupportAccess(ctx, { days: 1 }));
    assert(await visible(staff.id), "visible while live");
    await db
      .update(supportAccessGrants)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(supportAccessGrants.workspaceId, workspaceId));
    assert(!(await visible(staff.id)), "gone after expiry");
  });

  await check("a deleted workspace is never offered, even with a live grant", async () => {
    await runAsWorkspace(as(owner.id, "owner"), (ctx) => support.grantSupportAccess(ctx, { days: 1 }));
    await db.update(workspaces).set({ deletedAt: sql`now()` }).where(eq(workspaces.id, workspaceId));
    assert(!(await visible(staff.id)), "not offered");
  });

  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  for (const u of [owner, admin, staff, stranger]) await db.execute(sql`DELETE FROM auth.users WHERE id = ${u.id}`);
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
