/**
 * End-to-end: session security and platform controls. Session recording
 * and sign-in audit, idle and absolute timeouts, revocation, the strictest
 * policy across workspaces, MFA enforcement (policy and enrolled factor),
 * per-key rate limits, request metadata on API actors, and CSV escaping.
 *
 *   npx tsx scripts/test-security.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { auditLog, userSessions, workspaces } from "../src/lib/db/schema";
import { requestMeta, runAs, runAsWorkspace, userActor, workspaceActor } from "../src/lib/actor";
import { authenticateApiKey } from "../src/lib/agents/authenticate";
import * as agentsSvc from "../src/lib/agents/service";
import { consumeRateLimit } from "../src/lib/api/rate-limit";
import { checkSession, effectivePolicy, endSession, listSessions, revokeOtherSessions, type SessionClaims } from "../src/lib/security/sessions";
import { toCsv } from "../src/lib/ui/csv";
import * as ws from "../src/lib/workspace/service";
import { assert, assertEq, check, expectError, finish, section } from "./lib/harness";

const stamp = Date.now();
const PREFIX = `sect-${stamp}`;
const meta = { ipAddress: "203.0.113.7", userAgent: "test-agent/1.0" };

async function newUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `${tag}-${stamp}@example.com`;
  const [row] = await db.execute<{ id: string }>(sql`INSERT INTO auth.users (email) VALUES (${email}) RETURNING id`);
  return { id: row.id, email };
}

function claims(userId: string, over: Partial<SessionClaims> = {}): SessionClaims {
  return { userId, sessionId: randomUUID(), aal: "aal1", authenticatedAt: new Date(), methods: ["otp"], ...over };
}

async function main() {
  const user = await newUser("sess");
  const a = await db.transaction((tx) => ws.createWorkspace(tx, user, { name: `${PREFIX} One` }));
  const ownerA = workspaceActor({ workspaceId: a.workspaceId, userId: user.id, role: "owner" });
  const policyA = await runAsWorkspace(ownerA, (ctx) => ws.getSecurityPolicy(ctx));

  section("Sessions");
  const first = claims(user.id);
  await check("the first request records the session and audits the sign-in with IP and device", async () => {
    const v = await checkSession(first, meta);
    assert(v.ok, "accepted");
    const [row] = await db.select().from(userSessions).where(eq(userSessions.id, first.sessionId));
    assertEq(row.ipAddress, meta.ipAddress, "ip");
    const [ev] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, a.workspaceId), eq(auditLog.event, "auth.signed_in")));
    assertEq(ev.userAgent, meta.userAgent, "user agent on the audit row");
    assertEq(ev.organizationId, null, "workspace-level row");
  });

  await check("a session idle past the limit ends (and stays ended)", async () => {
    await db
      .update(userSessions)
      .set({ lastSeenAt: sql`now() - make_interval(mins => ${policyA.sessionIdleMinutes + 1})` })
      .where(eq(userSessions.id, first.sessionId));
    const v = await checkSession(first, meta);
    assert(!v.ok && v.reason === "idle_timeout", `expected idle_timeout, got ${JSON.stringify(v)}`);
    const again = await checkSession(first, meta);
    assert(!again.ok && again.reason === "revoked", "stays revoked");
    const [ev] = await db
      .select({ md: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, a.workspaceId), eq(auditLog.event, "auth.session.ended")));
    assertEq((ev.md as { reason: string }).reason, "idle_timeout", "audited with the reason");
  });

  await check("a session older than the maximum length ends, even when active or first seen", async () => {
    const fresh = claims(user.id);
    assert((await checkSession(fresh, meta)).ok, "fresh session accepted");
    await db
      .update(userSessions)
      .set({ authenticatedAt: sql`now() - make_interval(hours => ${policyA.sessionMaxHours + 1})` })
      .where(eq(userSessions.id, fresh.sessionId));
    const v = await checkSession(fresh, meta);
    assert(!v.ok && v.reason === "max_age", `expected max_age, got ${JSON.stringify(v)}`);
    const old = claims(user.id, { authenticatedAt: new Date(Date.now() - (policyA.sessionMaxHours + 1) * 3_600_000) });
    const first = await checkSession(old, meta);
    assert(!first.ok && first.reason === "max_age", "an old sign-in is rejected on first sight");
  });

  await check("sign-out and 'sign out everywhere else' end sessions", async () => {
    const s1 = claims(user.id);
    const s2 = claims(user.id);
    const s3 = claims(user.id);
    for (const s of [s1, s2, s3]) await checkSession(s, meta);
    await endSession(s1.sessionId, "signed_out", meta);
    assert(!(await checkSession(s1, meta)).ok, "signed-out session rejected");
    const ended = await revokeOtherSessions(user.id, s2.sessionId, meta);
    assert(ended >= 1, "others ended");
    assert((await checkSession(s2, meta)).ok, "kept session works");
    assert(!(await checkSession(s3, meta)).ok, "other session rejected");
    const live = await listSessions(user.id);
    assertEq(live.map((s) => s.id).join(), s2.sessionId, "only the kept session is live");
  });

  section("Policy");
  await check("the strictest policy across workspaces wins", async () => {
    const b = await db.transaction((tx) => ws.createWorkspace(tx, user, { name: `${PREFIX} Two` }));
    const ownerB = workspaceActor({ workspaceId: b.workspaceId, userId: user.id, role: "owner" });
    await runAsWorkspace(ownerB, (ctx) => ws.updateSecurityPolicy(ctx, { ...policyA, sessionIdleMinutes: 15, sessionMaxHours: 8 }));
    const p = await db.transaction((tx) => effectivePolicy(tx, user.id));
    assertEq(p.idleMinutes, 15, "idle from the stricter workspace");
    assertEq(p.maxHours, 8, "max from the stricter workspace");
  });

  await check("a workspace that requires MFA blocks one-factor sessions; aal2 passes", async () => {
    await runAsWorkspace(ownerA, (ctx) => ws.updateSecurityPolicy(ctx, { ...policyA, requireMfa: true }));
    const one = await checkSession(claims(user.id), meta);
    assert(!one.ok && one.reason === "mfa_required", `expected mfa_required, got ${JSON.stringify(one)}`);
    assert((await checkSession(claims(user.id, { aal: "aal2", methods: ["otp", "totp"] }), meta)).ok, "aal2 accepted");
    await runAsWorkspace(ownerA, (ctx) => ws.updateSecurityPolicy(ctx, { ...policyA, requireMfa: false }));
  });

  await check("someone with an enrolled factor must use it, policy or not", async () => {
    assert((await checkSession(claims(user.id), meta)).ok, "no factor yet: fine");
    await db.execute(sql`INSERT INTO auth.mfa_factors (user_id, status) VALUES (${user.id}, 'verified')`);
    const v = await checkSession(claims(user.id), meta);
    assert(!v.ok && v.reason === "mfa_required", "factor enrolled: one factor is not enough");
    const people = await runAsWorkspace(ownerA, (ctx) => ws.listPeople(ctx));
    assertEq(people[0].mfaEnabled, true, "people list shows 2-step on");
    await db.execute(sql`DELETE FROM auth.mfa_factors WHERE user_id = ${user.id}`);
  });

  section("API keys");
  await check("API actors carry the caller's IP and user agent into the audit trail", async () => {
    const owner = userActor({ organizationId: a.organizationId, userId: user.id, role: "owner" });
    const { token } = await runAs(owner, (ctx) => agentsSvc.createApiKey(ctx, { name: "meta" }));
    const headers = new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1", "user-agent": "claude-code/2" });
    const actor = await authenticateApiKey(token, "api", requestMeta(headers));
    assertEq(actor.ipAddress, "198.51.100.4", "first forwarded hop");
    assertEq(actor.userAgent, "claude-code/2", "user agent");
    assertEq(requestMeta(new Headers({ "x-forwarded-for": "not-an-ip" })).ipAddress, null, "garbage IPs dropped");
  });

  await check("each key has a per-minute budget; going over is rate_limited with a retry time", async () => {
    const owner = userActor({ organizationId: a.organizationId, userId: user.id, role: "owner" });
    const { key } = await runAs(owner, (ctx) => agentsSvc.createApiKey(ctx, { name: "burst" }));
    for (let i = 0; i < 3; i++) await consumeRateLimit(key.id, 3);
    const err = await expectError(() => consumeRateLimit(key.id, 3), "rate_limited");
    const retry = Number(err.details?.retryAfterSeconds);
    assert(retry >= 0 && retry <= 60, `retry after ${retry}s`);
  });

  section("Exports");
  await check("CSV cells are quoted and formula-looking values are neutralized", async () => {
    const csv = toCsv(["a", "b"], [["=HYPERLINK(\"x\")", 'say "hi", ok'], ["+1", null]]);
    assert(csv.includes(`"'=HYPERLINK(""x"")"`), "formula prefixed and quoted");
    assert(csv.includes(`"say ""hi"", ok"`), "quotes doubled");
    assert(csv.includes("'+1,"), "plus neutralized");
  });

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
