"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as agents from "@/lib/agents/service";

/** Agent + key server actions — wrappers over src/lib/agents/service.ts. */

export async function createAgent(input: agents.CreateAgentInput): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await agents.createAgent(ctx, input)).id,
  }));
  if (r.ok) revalidatePath("/settings/agents");
  return r;
}

export async function updateAgent(input: agents.UpdateAgentInput): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({
    id: (await agents.updateAgent(ctx, input)).id,
  }));
  if (r.ok) {
    revalidatePath("/settings/agents");
    revalidatePath(`/settings/agents/${input.id}`);
  }
  return r;
}

/** Mint a key. The plaintext token is returned here and never again. */
export async function createKey(
  input: agents.CreateApiKeyInput
): Promise<ActionResult<{ token: string }>> {
  const r = await serviceAction("viewer", async (ctx) => ({
    token: (await agents.createApiKey(ctx, input)).token,
  }));
  if (r.ok) {
    revalidatePath("/settings/agents");
    revalidatePath("/settings/api-keys");
    if (input.agentId) revalidatePath(`/settings/agents/${input.agentId}`);
  }
  return r;
}

export async function revokeKey(keyId: string): Promise<ActionResult> {
  const r = await serviceAction("viewer", (ctx) => agents.revokeApiKey(ctx, { id: keyId }));
  if (r.ok) {
    revalidatePath("/settings/agents", "layout");
    revalidatePath("/settings/api-keys");
  }
  return r;
}
