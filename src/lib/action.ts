import { runAs, runAsWorkspace, type Ctx, type Role, type WorkspaceRole, type WsCtx } from "@/lib/actor";
import { requireActor, requireWorkspaceActor } from "@/lib/auth";
import { toAppError, type ErrorCode } from "@/lib/errors";

/**
 * Glue between server actions and the service layer. A server action does:
 *
 *   export async function createCustomer(input: CustomerInput) {
 *     const r = await serviceAction("bookkeeper", (ctx) =>
 *       customers.createCustomer(ctx, input)
 *     );
 *     if (r.ok) revalidatePath("/customers");
 *     return r;
 *   }
 *
 * The minimum role here is a cheap early gate for the UI; the service
 * function re-checks with its own (authoritative) requirement.
 */
export type ActionResult<T extends object = { id: string }> =
  | ({ ok: true } & T)
  | { ok: false; error: string; code: ErrorCode };

export async function serviceAction<T extends object>(
  minRole: Role,
  fn: (ctx: Ctx) => Promise<T>
): Promise<ActionResult<T>> {
  // Outside the try: requireActor redirects / 403s via thrown control flow
  // that Next.js must see.
  const actor = await requireActor(minRole);
  try {
    const result = await runAs(actor, fn);
    return { ok: true, ...result };
  } catch (err) {
    const e = toAppError(err);
    return { ok: false, error: e.message, code: e.code };
  }
}

/** Same as serviceAction, for workspace-level services (people, policy, companies). */
export async function workspaceAction<T extends object>(
  minRole: WorkspaceRole,
  fn: (ctx: WsCtx) => Promise<T>
): Promise<ActionResult<T>> {
  const actor = await requireWorkspaceActor(minRole);
  try {
    const result = await runAsWorkspace(actor, fn);
    return { ok: true, ...result };
  } catch (err) {
    const e = toAppError(err);
    return { ok: false, error: e.message, code: e.code };
  }
}
