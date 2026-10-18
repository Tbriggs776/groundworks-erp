/**
 * Seed a demo organization with an owner key, a draft-mode agent key, and
 * a little data, then print the keys. For local API / MCP poking:
 *
 *   DATABASE_URL=… npx tsx scripts/dev/seed-demo.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { db } from "../../src/lib/db/client";
import { memberships, organizations, profiles } from "../../src/lib/db/schema";
import { runAs, userActor } from "../../src/lib/actor";
import * as agentsSvc from "../../src/lib/agents/service";
import { createItem } from "../../src/lib/ar/items";
import { generateFiscalYear } from "../../src/lib/gl/fiscal-calendar";
import { listAccounts } from "../../src/lib/gl/accounts";
import { createCustomer } from "../../src/lib/parties/service";
import { seedOrganizationDefaults } from "../../src/lib/seed/org-defaults";

async function main() {
  const [owner] = await db.select().from(profiles).limit(1);
  if (!owner) throw new Error("No profiles. Sign in once (or run scripts/dev/reset-test-db.sh).");
  const year = new Date().getFullYear();

  const org = await db.transaction(async (tx) => {
    const [o] = await tx
      .insert(organizations)
      .values({ name: "Demo Co", slug: `demo-${Date.now()}` })
      .returning();
    await tx.insert(memberships).values({ organizationId: o.id, userId: owner.id, role: "owner" });
    await seedOrganizationDefaults(tx, o.id, { includeDefaultCoa: true });
    await generateFiscalYear(tx, { organizationId: o.id, startDate: `${year}-01-01`, yearLabel: `FY${year}` });
    return o;
  });

  const actor = userActor({ organizationId: org.id, userId: owner.id, role: "owner" });
  const out = await runAs(actor, async (ctx) => {
    const services = (await listAccounts(ctx, { q: "Services" }))[0];
    await createCustomer(ctx, { name: "Northwind Traders", email: "ap@northwind.test" });
    await createItem(ctx, { name: "Consulting", salesPrice: "150", incomeAccountId: services.id });
    const ownerKey = await agentsSvc.createApiKey(ctx, {
      name: "demo owner",
      scopes: ["read", "write", "post", "admin"],
    });
    const agent = await agentsSvc.createAgent(ctx, { name: "Demo agent", autonomy: "draft" });
    const agentKey = await agentsSvc.createApiKey(ctx, { name: "demo", agentId: agent.id });
    return { ownerKey: ownerKey.token, agentKey: agentKey.token };
  });

  console.log(JSON.stringify({ organization: org.name, ...out }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
