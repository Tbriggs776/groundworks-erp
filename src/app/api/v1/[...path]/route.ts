import { handleRest } from "@/lib/api/rest";

/**
 * REST API v1 — every route is generated from the operation registry
 * (src/lib/api/operations.ts). Spec: /api/v1/openapi.json.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

async function handler(request: Request, { params }: Params) {
  const { path } = await params;
  return handleRest(request, path);
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
