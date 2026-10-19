import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { isIP } from "node:net";
import type { agentAutonomy, membershipRole, workspaceRole } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { money, type MoneyInput } from "@/lib/money";

/**
 * ACTOR — who is doing something, through which door, with what authority.
 *
 * Every service function takes a `Ctx` ({ actor, tx }) instead of reading
 * cookies or headers. The UI builds an actor from the Supabase session, the
 * REST API and MCP server build one from an API key, cron builds a system
 * actor. Same service code, same permission checks, same audit trail.
 *
 * Authority is two-dimensional:
 *   role   — what this principal may do in principle (owner … viewer)
 *   scopes — what this particular credential may do (read/write/post/admin)
 * An operation declares both a minimum role and a required scope; the actor
 * must satisfy both. UI sessions carry every scope their role allows.
 */

export type Role = (typeof membershipRole.enumValues)[number];
export type WorkspaceRole = (typeof workspaceRole.enumValues)[number];
export type Autonomy = (typeof agentAutonomy.enumValues)[number];
export type Scope = "read" | "write" | "post" | "admin";
export type Channel = "ui" | "api" | "mcp" | "system";

export const ALL_SCOPES: readonly Scope[] = ["read", "write", "post", "admin"];

export const ROLE_RANK = {
  owner: 5,
  admin: 4,
  accountant: 3,
  bookkeeper: 2,
  viewer: 0,
} as const satisfies Record<Role, number>;

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** The most a role can ever be granted, regardless of credential. */
export function scopesForRole(role: Role): Scope[] {
  if (role === "viewer") return ["read"];
  if (hasRole(role, "admin")) return [...ALL_SCOPES];
  return ["read", "write", "post"];
}

/** The most an agent's autonomy level allows. Never includes admin. */
export function scopesForAutonomy(autonomy: Autonomy): Scope[] {
  switch (autonomy) {
    case "read":
      return ["read"];
    case "draft":
      return ["read", "write"];
    case "post":
      return ["read", "write", "post"];
  }
}

export function intersectScopes(...sets: readonly (readonly string[])[]): Scope[] {
  return ALL_SCOPES.filter((s) => sets.every((set) => set.includes(s)));
}

export type Actor = {
  organizationId: string;
  kind: "user" | "agent" | "system";
  role: Role;
  /** Human principal (UI session or personal API key). */
  userId: string | null;
  /** Agent principal. */
  agentId: string | null;
  agentName: string | null;
  apiKeyId: string | null;
  scopes: readonly Scope[];
  channel: Channel;
  /** Agents only: posting ceiling per document, base currency. */
  maxPostAmount: string | null;
  requestId: string;
  /** Where the request came from, for the audit trail (when known). */
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Client address + user agent, taken from request headers. */
export type RequestMeta = { ipAddress: string | null; userAgent: string | null };

export function requestMeta(headers: Headers): RequestMeta {
  // First hop of x-forwarded-for is the client on Vercel and most proxies.
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim() || null;
  return {
    ipAddress: candidate && isIP(candidate) ? candidate : null,
    userAgent: headers.get("user-agent")?.slice(0, 512) ?? null,
  };
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Ctx = { actor: Actor; tx: Tx };

/** Actor for cron / background work. Owner-equivalent, no human attached. */
export function systemActor(organizationId: string): Actor {
  return {
    organizationId,
    kind: "system",
    role: "owner",
    userId: null,
    agentId: null,
    agentName: null,
    apiKeyId: null,
    scopes: ALL_SCOPES,
    channel: "system",
    maxPostAmount: null,
    requestId: randomUUID(),
  };
}

/** Actor for a signed-in human using the web app. */
export function userActor(opts: {
  organizationId: string;
  userId: string;
  role: Role;
  meta?: RequestMeta;
}): Actor {
  return {
    organizationId: opts.organizationId,
    kind: "user",
    role: opts.role,
    userId: opts.userId,
    agentId: null,
    agentName: null,
    apiKeyId: null,
    scopes: scopesForRole(opts.role),
    channel: "ui",
    maxPostAmount: null,
    requestId: randomUUID(),
    ipAddress: opts.meta?.ipAddress ?? null,
    userAgent: opts.meta?.userAgent ?? null,
  };
}

/**
 * Gate an operation. Throws `forbidden` with a message that tells the
 * caller exactly what was missing — agents relay these to their humans.
 */
export function requirePermission(
  actor: Actor,
  scope: Scope,
  minRole: Role,
  action: string
): void {
  if (!actor.scopes.includes(scope)) {
    throw new AppError(
      "forbidden",
      `This credential lacks the "${scope}" scope required to ${action}.`,
      { requiredScope: scope, scopes: actor.scopes }
    );
  }
  if (!hasRole(actor.role, minRole)) {
    throw new AppError(
      "forbidden",
      `Role "${actor.role}" cannot ${action}; "${minRole}" or higher is required.`,
      { requiredRole: minRole, role: actor.role }
    );
  }
}

/**
 * Agents with a posting ceiling may not post documents above it. The draft
 * stays put and shows up in the review queue for a human to post.
 */
export function requirePostingWithinLimit(
  actor: Actor,
  amount: MoneyInput,
  documentLabel: string
): void {
  if (actor.kind !== "agent" || actor.maxPostAmount === null) return;
  if (money(amount).gt(money(actor.maxPostAmount))) {
    throw new AppError(
      "approval_required",
      `${documentLabel} is ${money(amount).toFixed(2)}, above this agent's posting limit of ${money(actor.maxPostAmount).toFixed(2)}. It was not posted; a human needs to review and post it.`,
      { amount: money(amount).toFixed(2), limit: money(actor.maxPostAmount).toFixed(2) }
    );
  }
}

/** Audit-log columns describing this actor. Spread into writeAudit(). */
export function auditFields(actor: Actor) {
  return {
    actorId: actor.userId,
    actorType: actor.kind,
    agentId: actor.agentId,
    apiKeyId: actor.apiKeyId,
    channel: actor.channel,
    requestId: actor.requestId,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  };
}

/** `created_by` / `created_by_agent_id` for a new document. */
export function creatorFields(actor: Actor) {
  return { createdBy: actor.userId, createdByAgentId: actor.agentId };
}

/**
 * Run a unit of work as `actor` inside one transaction. Anything thrown
 * rolls back every write, the audit rows included.
 */
export async function runAs<T>(
  actor: Actor,
  fn: (ctx: Ctx) => Promise<T>
): Promise<T> {
  return db.transaction((tx) => fn({ actor, tx }));
}

// ---------------------------------------------------------------------------
// Workspace actors: people managing the account above the companies
// (people, company access, security policy). Humans only; agents and API
// keys never act at workspace level.
// ---------------------------------------------------------------------------

export const WORKSPACE_ROLE_RANK = {
  owner: 2,
  admin: 1,
  member: 0,
} as const satisfies Record<WorkspaceRole, number>;

export function hasWorkspaceRole(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[min];
}

export type WorkspaceActor = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  requestId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type WsCtx = { actor: WorkspaceActor; tx: Tx };

export function workspaceActor(opts: {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  meta?: RequestMeta;
}): WorkspaceActor {
  return {
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    role: opts.role,
    requestId: randomUUID(),
    ipAddress: opts.meta?.ipAddress ?? null,
    userAgent: opts.meta?.userAgent ?? null,
  };
}

export function requireWorkspaceRole(actor: WorkspaceActor, min: WorkspaceRole, action: string): void {
  if (!hasWorkspaceRole(actor.role, min)) {
    throw new AppError(
      "forbidden",
      `Workspace role "${actor.role}" cannot ${action}; "${min}" or higher is required.`,
      { requiredRole: min, role: actor.role }
    );
  }
}

/** Audit-log columns for a workspace-level event. Spread into writeAudit(). */
export function workspaceAuditFields(actor: WorkspaceActor) {
  return {
    workspaceId: actor.workspaceId,
    actorId: actor.userId,
    actorType: "user" as const,
    channel: "ui" as const,
    requestId: actor.requestId,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  };
}

export async function runAsWorkspace<T>(
  actor: WorkspaceActor,
  fn: (ctx: WsCtx) => Promise<T>
): Promise<T> {
  return db.transaction((tx) => fn({ actor, tx }));
}
