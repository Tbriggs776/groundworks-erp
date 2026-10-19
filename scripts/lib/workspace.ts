/**
 * Test fixtures predate workspaces: every company now needs one. These
 * helpers give a fixture company its own workspace (same slug) and clean
 * both up together.
 */
import { like } from "drizzle-orm";
import type { db } from "../../src/lib/db/client";
import { organizations, workspaces } from "../../src/lib/db/schema";

type Conn = Pick<typeof db, "insert" | "delete">;

export async function testWorkspace(conn: Conn, slug: string, name = slug): Promise<string> {
  const [w] = await conn.insert(workspaces).values({ name, slug }).returning({ id: workspaces.id });
  return w.id;
}

/** Delete fixture companies and their workspaces by slug prefix. */
export async function deleteFixtures(conn: Conn, slugPrefix: string): Promise<void> {
  await conn.delete(organizations).where(like(organizations.slug, `${slugPrefix}%`));
  await conn.delete(workspaces).where(like(workspaces.slug, `${slugPrefix}%`));
}
