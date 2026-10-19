import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, profiles } from "@/lib/db/schema";

export type Creator = { kind: "agent" | "user"; label: string } | null;

/** "Created by" label for a document: the agent's name or the person's email. */
export async function creatorOf(doc: {
  createdBy: string | null;
  createdByAgentId: string | null;
}): Promise<Creator> {
  if (doc.createdByAgentId) {
    const [a] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, doc.createdByAgentId));
    return a ? { kind: "agent", label: a.name } : null;
  }
  if (doc.createdBy) {
    const [p] = await db
      .select({ email: profiles.email, fullName: profiles.fullName })
      .from(profiles)
      .where(eq(profiles.id, doc.createdBy));
    return p ? { kind: "user", label: p.fullName ?? p.email } : null;
  }
  return null;
}
