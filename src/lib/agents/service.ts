import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agentAutonomy,
  agents,
  apiKeys,
  organizations,
  profiles,
  workspaces,
  type Agent,
  type ApiKey,
} from "@/lib/db/schema";
import {
  ALL_SCOPES,
  auditFields,
  intersectScopes,
  requirePermission,
  scopesForRole,
  type Ctx,
  type Scope,
} from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError, notFound, rethrowUnique } from "@/lib/errors";
import { id, nonNegativeAmount, optionalText } from "@/lib/schemas";
import { generateApiKey } from "./keys";

/**
 * Agent + API key management. Admin-only, except personal keys: any member
 * may mint a key for themselves, capped at what their own role allows.
 *
 * Keys are returned in plaintext exactly once, from createApiKey. After
 * that only the prefix is ever shown.
 */

const AGENT_ROLES = ["accountant", "bookkeeper", "viewer"] as const;

export const CreateAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalText(500),
  role: z.enum(AGENT_ROLES).default("bookkeeper"),
  autonomy: z.enum(agentAutonomy.enumValues).default("draft"),
  maxPostAmount: nonNegativeAmount
    .optional()
    .nullable()
    .describe("Per-document posting ceiling. Null = unlimited (autonomy=post only)."),
});
export type CreateAgentInput = z.input<typeof CreateAgentSchema>;

export const UpdateAgentSchema = CreateAgentSchema.partial().extend({
  id,
  isActive: z.boolean().optional(),
});
export type UpdateAgentInput = z.input<typeof UpdateAgentSchema>;

const scopeEnum = z.enum(ALL_SCOPES as [Scope, ...Scope[]]);

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  agentId: id.optional().describe("Mint the key for this agent. Omit for a personal key."),
  scopes: z.array(scopeEnum).min(1).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiKeyInput = z.input<typeof CreateApiKeySchema>;

export type AgentWithKeys = Agent & {
  keys: Array<Pick<ApiKey, "id" | "name" | "prefix" | "scopes" | "createdAt" | "lastUsedAt" | "expiresAt" | "revokedAt">>;
};

function keyView(k: ApiKey) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    revokedAt: k.revokedAt,
  };
}

export async function listAgents(ctx: Ctx): Promise<AgentWithKeys[]> {
  requirePermission(ctx.actor, "read", "viewer", "list agents");
  const org = ctx.actor.organizationId;
  const rows = await ctx.tx
    .select()
    .from(agents)
    .where(and(eq(agents.organizationId, org), isNull(agents.deletedAt)))
    .orderBy(asc(agents.name));
  const keys = await ctx.tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, org), sql`${apiKeys.agentId} IS NOT NULL`))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((a) => ({
    ...a,
    keys: keys.filter((k) => k.agentId === a.id).map(keyView),
  }));
}

async function loadAgent(ctx: Ctx, agentId: string): Promise<Agent> {
  const [a] = await ctx.tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, ctx.actor.organizationId)));
  if (!a) throw notFound("Agent");
  return a;
}

export async function createAgent(ctx: Ctx, input: CreateAgentInput): Promise<Agent> {
  requirePermission(ctx.actor, "admin", "admin", "create agents");
  const data = CreateAgentSchema.parse(input);
  const org = ctx.actor.organizationId;
  let agent: Agent;
  try {
    [agent] = await ctx.tx
      .insert(agents)
      .values({
        organizationId: org,
        name: data.name,
        description: data.description,
        role: data.role,
        autonomy: data.autonomy,
        maxPostAmount: data.maxPostAmount ?? null,
        createdBy: ctx.actor.userId,
      })
      .returning();
  } catch (err) {
    rethrowUnique(err, `An agent named "${data.name}" already exists.`);
  }
  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      metadata: { name: agent.name, role: agent.role, autonomy: agent.autonomy, maxPostAmount: agent.maxPostAmount },
    },
    ctx.tx
  );
  return agent;
}

export async function updateAgent(ctx: Ctx, input: UpdateAgentInput): Promise<Agent> {
  requirePermission(ctx.actor, "admin", "admin", "change agents");
  const data = UpdateAgentSchema.parse(input);
  const before = await loadAgent(ctx, data.id);
  let agent: Agent;
  try {
    [agent] = await ctx.tx
      .update(agents)
      .set({
        name: data.name ?? before.name,
        description: data.description !== undefined ? data.description : before.description,
        role: data.role ?? before.role,
        autonomy: data.autonomy ?? before.autonomy,
        maxPostAmount:
          data.maxPostAmount !== undefined ? data.maxPostAmount : before.maxPostAmount,
        isActive: data.isActive ?? before.isActive,
        updatedAt: sql`now()`,
      })
      .where(eq(agents.id, before.id))
      .returning();
  } catch (err) {
    rethrowUnique(err, `An agent named "${data.name}" already exists.`);
  }
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      metadata: {
        before: { role: before.role, autonomy: before.autonomy, maxPostAmount: before.maxPostAmount, isActive: before.isActive },
        after: { role: agent.role, autonomy: agent.autonomy, maxPostAmount: agent.maxPostAmount, isActive: agent.isActive },
      },
    },
    ctx.tx
  );
  return agent;
}

/**
 * Mint a key. For an agent (admin only), the key's ceiling defaults to
 * read/write/post and the agent's autonomy + role decide what is live. For
 * yourself, scopes default to read and may not exceed your role. The
 * plaintext token is in the return value and nowhere else, ever.
 */
export async function createApiKey(
  ctx: Ctx,
  input: CreateApiKeyInput
): Promise<{ token: string; key: ReturnType<typeof keyView> }> {
  const data = CreateApiKeySchema.parse(input);
  const org = ctx.actor.organizationId;
  if (ctx.actor.kind !== "user" || !ctx.actor.userId) {
    throw new AppError("forbidden", "Only a signed-in person can create API keys.");
  }

  let scopes: Scope[];
  if (data.agentId) {
    requirePermission(ctx.actor, "admin", "admin", "create agent keys");
    const agent = await loadAgent(ctx, data.agentId);
    if (!agent.isActive) throw new AppError("invalid_state", "Agent is deactivated.");
    // Agent keys default to every non-admin scope: the agent's autonomy and
    // role narrow them on each request, so changing the agent's autonomy
    // takes effect on existing keys in both directions. Pass `scopes` to
    // mint a key that stays narrower than the agent.
    scopes = intersectScopes(data.scopes ?? ["read", "write", "post"], ["read", "write", "post"]);
  } else {
    requirePermission(ctx.actor, "read", "viewer", "create a personal API key");
    const allowed = scopesForRole(ctx.actor.role);
    scopes = intersectScopes(data.scopes ?? ["read"], allowed);
  }
  if (scopes.length === 0) {
    throw new AppError("invalid_input", "None of the requested scopes are allowed for this principal.");
  }

  // Workspace policy: keys must expire within the configured lifetime.
  const [{ maxDays }] = await ctx.tx
    .select({ maxDays: workspaces.apiKeyMaxDays })
    .from(organizations)
    .innerJoin(workspaces, eq(workspaces.id, organizations.workspaceId))
    .where(eq(organizations.id, org));
  if (maxDays && data.expiresInDays && data.expiresInDays > maxDays) {
    throw new AppError(
      "invalid_input",
      `Your workspace limits API keys to ${maxDays} days. Choose ${maxDays} or fewer.`,
      { maxDays }
    );
  }
  const expiresInDays = data.expiresInDays ?? maxDays ?? null;

  const { token, prefix, secretHash } = generateApiKey();
  const [key] = await ctx.tx
    .insert(apiKeys)
    .values({
      organizationId: org,
      agentId: data.agentId ?? null,
      userId: data.agentId ? null : ctx.actor.userId,
      name: data.name,
      prefix,
      secretHash,
      scopes,
      expiresAt: expiresInDays ? sql`now() + make_interval(days => ${expiresInDays})` : null,
      createdBy: ctx.actor.userId,
    })
    .returning();

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(ctx.actor),
      event: "api_key.created",
      entityType: "api_key",
      entityId: key.id,
      metadata: { name: key.name, prefix, scopes, agentId: key.agentId, userId: key.userId },
    },
    ctx.tx
  );
  return { token, key: keyView(key) };
}

export type PersonalKeyRow = ReturnType<typeof keyView>;

/** Your own personal keys. */
export async function listMyApiKeys(ctx: Ctx): Promise<PersonalKeyRow[]> {
  if (!ctx.actor.userId) return [];
  const rows = await ctx.tx
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, ctx.actor.organizationId),
        eq(apiKeys.userId, ctx.actor.userId)
      )
    )
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(keyView);
}

/** Every personal key in the org, for admins. */
export async function listPersonalKeys(
  ctx: Ctx
): Promise<Array<PersonalKeyRow & { userEmail: string }>> {
  requirePermission(ctx.actor, "admin", "admin", "list everyone's API keys");
  const rows = await ctx.tx
    .select({ key: apiKeys, email: profiles.email })
    .from(apiKeys)
    .innerJoin(profiles, eq(profiles.id, apiKeys.userId))
    .where(eq(apiKeys.organizationId, ctx.actor.organizationId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({ ...keyView(r.key), userEmail: r.email }));
}

export async function revokeApiKey(ctx: Ctx, input: { id: string }): Promise<{ id: string }> {
  const keyId = id.parse(input.id);
  const [key] = await ctx.tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, ctx.actor.organizationId)));
  if (!key) throw notFound("API key");
  const ownKey = key.userId !== null && key.userId === ctx.actor.userId;
  if (!ownKey) requirePermission(ctx.actor, "admin", "admin", "revoke other people's keys");
  if (key.revokedAt) return { id: key.id };

  await ctx.tx
    .update(apiKeys)
    .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(apiKeys.id, key.id));
  await writeAudit(
    {
      organizationId: ctx.actor.organizationId,
      ...auditFields(ctx.actor),
      event: "api_key.revoked",
      entityType: "api_key",
      entityId: key.id,
      metadata: { name: key.name, prefix: key.prefix },
    },
    ctx.tx
  );
  return { id: key.id };
}
