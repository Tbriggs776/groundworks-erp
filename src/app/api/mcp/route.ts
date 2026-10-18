import { handleMcp } from "@/lib/api/mcp";

/**
 * MCP server (Streamable HTTP, stateless JSON responses). Connect with an
 * API key as a bearer token, e.g.
 *   claude mcp add --transport http groundworks https://<host>/api/mcp \
 *     --header "Authorization: Bearer gwk_…"
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleMcp(request);
}

// No server-initiated SSE stream and no sessions to end.
function methodNotAllowed() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
export { methodNotAllowed as GET, methodNotAllowed as DELETE };
