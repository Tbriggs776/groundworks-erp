import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentOrg, requireActor, requireWorkspaceActor } from "@/lib/auth";
import { qboConfigured } from "@/lib/qbo/config";
import { STATE_COOKIE, startAuthorization } from "@/lib/qbo/oauth";

/**
 * Start Intuit's sign-in: to import a company into this workspace
 * (workspace admins), or with ?reconnect=1 to reconnect the active company
 * (its admins). The nonce cookie ties the callback to this browser.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const reconnect = url.searchParams.get("reconnect") === "1";
  if (!qboConfigured()) return NextResponse.redirect(new URL("/workspace?qbo=not-configured", req.url));
  let who: { workspaceId: string; userId: string; organizationId?: string };
  if (reconnect) {
    const actor = await requireActor("admin");
    const org = await getCurrentOrg();
    who = { workspaceId: org?.organization.workspaceId ?? "", userId: actor.userId ?? "", organizationId: actor.organizationId };
  } else {
    const ws = await requireWorkspaceActor("admin");
    who = { workspaceId: ws.workspaceId, userId: ws.userId };
  }
  const { url: authUrl, nonce } = startAuthorization(who);
  (await cookies()).set(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/qbo",
    maxAge: 600,
  });
  return NextResponse.redirect(authUrl);
}
