/**
 * End-to-end: agents, API keys, and key authentication — scope math,
 * autonomy levels, revocation, expiry, deactivation, membership removal,
 * and who may mint what.
 *
 *   npx tsx scripts/test-agents.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { apiKeys, auditLog, memberships } from "../src/lib/db/schema";
import { authenticateApiKey, tokenFromHeaders } from "../src/lib/agents/authenticate";
import { generateApiKey, hashApiKey, looksLikeApiKey } from "../src/lib/agents/keys";
import * as agentsSvc from "../src/lib/agents/service";
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

async function main() {
  const t = await createTestOrg("agents-test-");
  console.log(`\nTest org: ${t.org.slug}`);
  const admin = t.as("admin");

  section("Key format");
  await check("keys are gwk_ + 40 chars, prefix is 12, only the hash is stored", async () => {
    const k = generateApiKey();
    assert(looksLikeApiKey(k.token), k.token);
    assertEq(k.prefix, k.token.slice(0, 12), "prefix");
    assertEq(k.secretHash, hashApiKey(k.token), "hash");
    assert(!k.secretHash.includes(k.token.slice(4)), "hash must not contain the secret");
    assert(generateApiKey().token !== k.token, "unique");
  });

  await check("bearer and x-api-key headers are both accepted", async () => {
    assertEq(tokenFromHeaders(new Headers({ authorization: "Bearer gwk_abc" })), "gwk_abc", "bearer");
    assertEq(tokenFromHeaders(new Headers({ "x-api-key": "gwk_xyz" })), "gwk_xyz", "x-api-key");
  });

  section("Agent keys");
  let draftAgentId = "";
  let draftToken = "";
  await check("admin creates a draft-autonomy bookkeeper agent + key", async () => {
    const r = await t.run(admin, async (ctx) => {
      const agent = await agentsSvc.createAgent(ctx, { name: "Inbox bot", autonomy: "draft" });
      const key = await agentsSvc.createApiKey(ctx, { name: "prod", agentId: agent.id });
      return { agent, key };
    });
    draftAgentId = r.agent.id;
    draftToken = r.key.token;
    assertEq(r.agent.role, "bookkeeper", "default role");
    assertEq(r.key.key.scopes.join(","), "read,write,post", "key ceiling");
  });

  await check("the key authenticates as that agent with read+write", async () => {
    const actor = await authenticateApiKey(draftToken, "api");
    assertEq(actor.kind, "agent", "kind");
    assertEq(actor.agentId, draftAgentId, "agentId");
    assertEq(actor.userId, null, "userId");
    assertEq(actor.scopes.join(","), "read,write", "scopes");
    assertEq(actor.channel, "api", "channel");
  });

  await check("raising autonomy to post widens existing keys immediately", async () => {
    await t.run(admin, (ctx) =>
      agentsSvc.updateAgent(ctx, { id: draftAgentId, autonomy: "post", maxPostAmount: "250" })
    );
    const actor = await authenticateApiKey(draftToken, "mcp");
    assertEq(actor.scopes.join(","), "read,write,post", "scopes");
    assertEq(actor.maxPostAmount, "250.0000", "ceiling carried");
  });

  await check("a deliberately narrow key stays narrow when autonomy rises", async () => {
    const token = await t.run(admin, async (ctx) =>
      (await agentsSvc.createApiKey(ctx, { name: "ro", agentId: draftAgentId, scopes: ["read"] })).token
    );
    const actor = await authenticateApiKey(token, "api");
    assertEq(actor.scopes.join(","), "read", "scopes");
  });

  await check("lowering autonomy to read narrows the key immediately", async () => {
    await t.run(admin, (ctx) => agentsSvc.updateAgent(ctx, { id: draftAgentId, autonomy: "read" }));
    const actor = await authenticateApiKey(draftToken, "api");
    assertEq(actor.scopes.join(","), "read", "scopes");
  });

  await check("agents can't be admins", async () => {
    await expectError(
      () => t.run(admin, (ctx) => agentsSvc.createAgent(ctx, { name: "Root bot", role: "admin" as "bookkeeper" })),
      "invalid_input"
    );
  });

  await check("viewer-role agent with post autonomy is still read-only", async () => {
    const token = await t.run(admin, async (ctx) => {
      const a = await agentsSvc.createAgent(ctx, { name: "Reporter", role: "viewer", autonomy: "post" });
      return (await agentsSvc.createApiKey(ctx, { name: "k", agentId: a.id })).token;
    });
    const actor = await authenticateApiKey(token, "api");
    assertEq(actor.scopes.join(","), "read", "scopes");
  });

  await check("deactivated agent's keys stop working", async () => {
    await t.run(admin, (ctx) => agentsSvc.updateAgent(ctx, { id: draftAgentId, isActive: false }));
    await expectError(() => authenticateApiKey(draftToken, "api"), "unauthenticated");
  });

  await check("bookkeeper cannot create agents", async () => {
    await expectError(
      () => t.run(t.as("bookkeeper"), (ctx) => agentsSvc.createAgent(ctx, { name: "Nope" })),
      "forbidden"
    );
  });

  section("Personal keys");
  let personalToken = "";
  let personalKeyId = "";
  await check("a viewer's personal key is capped at read", async () => {
    const r = await t.run(t.as("viewer"), (ctx) =>
      agentsSvc.createApiKey(ctx, { name: "laptop", scopes: ["read", "write", "post"] })
    );
    assertEq(r.key.scopes.join(","), "read", "capped");
  });

  await check("an owner's personal key acts as the owner", async () => {
    const r = await t.run(t.as("owner"), (ctx) =>
      agentsSvc.createApiKey(ctx, { name: "claude code", scopes: ["read", "write", "post"] })
    );
    personalToken = r.token;
    personalKeyId = r.key.id;
    const actor = await authenticateApiKey(personalToken, "mcp");
    assertEq(actor.kind, "user", "kind");
    assertEq(actor.userId, t.owner.id, "userId");
    assertEq(actor.role, "owner", "role");
    assertEq(actor.scopes.join(","), "read,write,post", "scopes");
  });

  await check("a member's lowered role applies to their key immediately", async () => {
    await db
      .update(memberships)
      .set({ role: "viewer" })
      .where(and(eq(memberships.organizationId, t.org.id), eq(memberships.userId, t.owner.id)));
    const actor = await authenticateApiKey(personalToken, "api");
    assertEq(actor.scopes.join(","), "read", "scopes");
    await db
      .update(memberships)
      .set({ role: "owner" })
      .where(and(eq(memberships.organizationId, t.org.id), eq(memberships.userId, t.owner.id)));
  });

  await check("deactivated membership kills personal keys", async () => {
    await db
      .update(memberships)
      .set({ isActive: false })
      .where(and(eq(memberships.organizationId, t.org.id), eq(memberships.userId, t.owner.id)));
    await expectError(() => authenticateApiKey(personalToken, "api"), "unauthenticated");
    await db
      .update(memberships)
      .set({ isActive: true })
      .where(and(eq(memberships.organizationId, t.org.id), eq(memberships.userId, t.owner.id)));
  });

  await check("revoked keys fail; revocation is audited", async () => {
    await t.run(t.as("owner"), (ctx) => agentsSvc.revokeApiKey(ctx, { id: personalKeyId }));
    await expectError(() => authenticateApiKey(personalToken, "api"), "unauthenticated");
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, personalKeyId), eq(auditLog.event, "api_key.revoked")));
    assertEq(rows.length, 1, "audit rows");
  });

  await check("expired keys fail", async () => {
    const r = await t.run(t.as("owner"), (ctx) =>
      agentsSvc.createApiKey(ctx, { name: "short", expiresInDays: 1 })
    );
    await db
      .update(apiKeys)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(apiKeys.id, r.key.id));
    await expectError(() => authenticateApiKey(r.token, "api"), "unauthenticated");
  });

  await check("garbage and unknown tokens fail the same way", async () => {
    await expectError(() => authenticateApiKey("hello", "api"), "unauthenticated");
    await expectError(() => authenticateApiKey(generateApiKey().token, "api"), "unauthenticated");
    await expectError(() => authenticateApiKey(null, "api"), "unauthenticated");
  });

  await check("agents cannot mint keys", async () => {
    const actor = { ...t.as("bookkeeper"), kind: "agent" as const, userId: null, agentId: draftAgentId };
    await expectError(
      () => t.run(actor, (ctx) => agentsSvc.createApiKey(ctx, { name: "escalate" })),
      "forbidden"
    );
  });

  await deleteOrgs("agents-test-");
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
