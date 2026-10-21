import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { runAs, runAsWorkspace } from "@/lib/actor";
import { ACTIVE_ORG_COOKIE, ACTIVE_WORKSPACE_COOKIE, requireActor, requireUser, requireWorkspaceActor } from "@/lib/auth";
import { AppError, toAppError } from "@/lib/errors";
import { checkState, STATE_COOKIE } from "@/lib/qbo/oauth";
import { beginImport, reconnect } from "@/lib/qbo/service";

/**
 * Intuit sends the person back here. A new import makes the company and
 * switches to it; a reconnect refreshes the company's tokens. Either way
 * the import page takes it from there.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const nonce = jar.get(STATE_COOKIE)?.value;
  jar.delete({ name: STATE_COOKIE, path: "/api/qbo" });
  const back = (path: string) => NextResponse.redirect(new URL(path, req.url));
  const denied = url.searchParams.get("error");
  if (denied) return back(denied === "access_denied" ? "/workspace?qbo=cancelled" : "/workspace?qbo=error");

  const user = await requireUser();
  const state = (() => {
    try {
      return checkState(url.searchParams.get("state"), nonce, user.id);
    } catch {
      return null;
    }
  })();
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  if (!state || !code || !realmId) return back("/workspace?qbo=expired");

  if (state.o) {
    const actor = await requireActor("admin");
    try {
      if (actor.organizationId !== state.o) throw new AppError("forbidden", "Switch to the company you were reconnecting, then try again.");
      await runAs(actor, (ctx) => reconnect(ctx, { code, realmId }));
    } catch (err) {
      return back(`/settings/quickbooks?error=${encodeURIComponent(toAppError(err).message)}`);
    }
    return back("/settings/quickbooks");
  }

  const ws = await requireWorkspaceActor("admin");
  let organizationId: string;
  try {
    if (ws.workspaceId !== state.w) throw new AppError("forbidden", "Switch to the workspace you started the import from, then try again.");
    ({ organizationId } = await runAsWorkspace(ws, (ctx) => beginImport(ctx, { code, realmId })));
  } catch (err) {
    return back(`/workspace?qbo=error&message=${encodeURIComponent(toAppError(err).message)}`);
  }
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 };
  jar.set(ACTIVE_WORKSPACE_COOKIE, ws.workspaceId, opts);
  jar.set(ACTIVE_ORG_COOKIE, organizationId, opts);
  return back("/settings/quickbooks");
}
